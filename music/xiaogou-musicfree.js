"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const CryptoJs = require("crypto-js");
const he = require("he");

const pageSize = 20;
const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9",
};

function imageUrl(url, size) {
    return url ? url.replace("{size}", String(size)) : undefined;
}

function formatMusicItem(item) {
    const group = item.Grp && item.Grp[0];
    return {
        id: String(item.FileHash || (group && group.FileHash) || ""),
        title: item.SongName || item.OriSongName || "",
        artist: item.SingerName || (item.Singers && item.Singers[0] && item.Singers[0].name) || "",
        album: item.AlbumName || (group && group.AlbumName) || "",
        album_id: item.AlbumID || (group && group.AlbumID),
        album_audio_id: 0,
        duration: item.Duration,
        artwork: imageUrl(item.Image || (group && group.Image), 1080),
        "320hash": item.HQFileHash,
        sqhash: item.SQFileHash,
        ResFileHash: item.ResFileHash,
    };
}

function formatRankMusicItem(item) {
    const filename = item.filename || "";
    const split = filename.indexOf("-");
    const artist = item.singername || (split > 0 ? filename.slice(0, split).trim() : "");
    return {
        id: String(item.hash || ""),
        title: item.songname || (split > 0 ? filename.slice(split + 1).trim() : filename),
        artist,
        album: item.album_name || item.remark,
        album_id: item.album_id,
        album_audio_id: item.album_audio_id,
        artwork: imageUrl(item.album_sizable_cover, 400),
        duration: item.duration,
        "320hash": item["320hash"],
        sqhash: item.sqhash,
        origin_hash: item.origin_hash,
    };
}

const qualityLevels = {
    low: "128k",
    standard: "320k",
    high: "320k",
    super: "320k",
};

async function searchMusic(query, page) {
    const res = (await axios.get("https://songsearch.kugou.com/song_search_v2", {
        headers,
        params: {
            keyword: query,
            page,
            pagesize: pageSize,
            userid: 0,
            clientver: "",
            platform: "WebFilter",
            filter: 2,
            iscorrection: 1,
            privilege_filter: 0,
            area_code: 1,
        },
    })).data;
    const data = (res.data && res.data.lists || []).map(formatMusicItem);
    const total = Number(res.data && res.data.total || 0);
    return { isEnd: page * pageSize >= total || data.length < pageSize, data };
}

async function searchAlbum(query, page) {
    const res = (await axios.get("http://msearch.kugou.com/api/v3/search/album", {
        headers,
        params: {
            version: 9108,
            iscorrection: 1,
            highlight: "em",
            plat: 0,
            keyword: query,
            pagesize: pageSize,
            page,
            sver: 2,
            with_res_tag: 0,
        },
    })).data;
    const data = (res.data && res.data.info || []).map((item) => ({
        id: String(item.albumid),
        artwork: imageUrl(item.imgurl, 400),
        artist: item.singername,
        title: cheerio.load(item.albumname || "").text(),
        description: item.intro,
        date: item.publishtime && item.publishtime.slice(0, 10),
    }));
    return { isEnd: page * pageSize >= Number(res.data && res.data.total || 0) || data.length < pageSize, data };
}

async function searchMusicSheet(query, page) {
    const res = (await axios.get("http://mobilecdn.kugou.com/api/v3/search/special", {
        headers,
        params: { format: "json", keyword: query, page, pagesize: pageSize, showtype: 1 },
    })).data;
    const data = (res.data && res.data.info || []).map((item) => ({
        id: String(item.specialid),
        title: item.specialname,
        createAt: item.publishtime,
        description: item.intro,
        artist: item.nickname,
        artwork: imageUrl(item.imgurl, 400),
        coverImg: imageUrl(item.imgurl, 400),
        gid: item.gid,
        playCount: item.playcount,
        worksNum: item.songcount,
    }));
    return { isEnd: page * pageSize >= Number(res.data && res.data.total || 0) || data.length < pageSize, data };
}

async function getMediaSource(musicItem, quality) {
    const level = qualityLevels[quality] || qualityLevels.standard;
    const res = (await axios.get("https://lxmusicapi.onrender.com/url/kg/" + encodeURIComponent(musicItem.id) + "/" + level, {
        headers: { "X-Request-Key": "share-v3" },
    })).data;
    if (!res || !res.url) throw new Error("该歌曲暂无可用音源");
    return { url: res.url };
}

async function getTopLists() {
    const lists = (await axios.get("http://mobilecdnbj.kugou.com/api/v3/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=0&with_res_tag=0", { headers })).data.data.info;
    const groups = [
        { title: "热门榜单", data: [] },
        { title: "特色音乐榜", data: [] },
        { title: "全球榜", data: [] },
    ];
    const extra = { title: "其他", data: [] };
    lists.forEach((item) => {
        const rank = {
            id: String(item.rankid),
            description: item.intro,
            artwork: imageUrl(item.imgurl, 400),
            coverImg: imageUrl(item.imgurl, 400),
            title: item.rankname,
        };
        if (item.classify === 1 || item.classify === 2) groups[0].data.push(rank);
        else if (item.classify === 3 || item.classify === 5) groups[1].data.push(rank);
        else if (item.classify === 4) groups[2].data.push(rank);
        else extra.data.push(rank);
    });
    if (extra.data.length) groups.push(extra);
    return groups;
}

async function getTopListDetail(topListItem, page) {
    const currentPage = page || 1;
    const pageSizeForRank = 100;
    const res = await axios.get("http://mobilecdnbj.kugou.com/api/v3/rank/song", {
        headers,
        params: {
            version: 9108,
            ranktype: 0,
            plat: 0,
            pagesize: pageSizeForRank,
            area_code: 1,
            page: currentPage,
            volid: 35050,
            rankid: topListItem.id,
            with_res_tag: 0,
        },
    });
    const info = res.data.data.info || [];
    const total = Number(res.data.data.total || info.length);
    return {
        isEnd: currentPage * pageSizeForRank >= total || info.length < pageSizeForRank,
        musicList: info.map(formatRankMusicItem),
    };
}

async function getLyricDownload(lyrdata) {
    const result = (await axios.get("http://lyrics.kugou.com/download", {
        params: { ver: 1, client: "pc", id: lyrdata.id, accesskey: lyrdata.accessKey, fmt: "lrc", charset: "utf8" },
        headers: { "KG-RC": 1, "KG-THash": "expand_search_manager.cpp:852736169:451", "User-Agent": "KuGou2012-9020-ExpandSearchManager" },
    })).data;
    if (!result || !result.content) throw new Error("歌词不存在");
    return { rawLrc: he.decode(CryptoJs.enc.Base64.parse(result.content).toString(CryptoJs.enc.Utf8)) };
}

async function getLyric(musicItem) {
    const result = (await axios.get("http://lyrics.kugou.com/search", {
        params: { ver: 1, man: "yes", client: "pc", keyword: musicItem.title, hash: musicItem.id, timelength: musicItem.duration },
        headers: { "KG-RC": 1, "KG-THash": "expand_search_manager.cpp:852736169:451", "User-Agent": "KuGou2012-9020-ExpandSearchManager" },
    })).data;
    const info = result && result.candidates && result.candidates[0];
    if (!info) throw new Error("歌词不存在");
    return getLyricDownload({ id: info.id, accessKey: info.accesskey });
}

async function getAlbumInfo(albumItem, page) {
    const currentPage = page || 1;
    const res = (await axios.get("http://mobilecdn.kugou.com/api/v3/album/song", {
        params: { version: 9108, albumid: albumItem.id, plat: 0, pagesize: 100, area_code: 1, page: currentPage, with_res_tag: 0 },
    })).data;
    const info = res.data.info || [];
    return {
        isEnd: currentPage * 100 >= Number(res.data.total || info.length) || info.length < 100,
        albumItem: currentPage === 1 ? { worksNum: res.data.total } : undefined,
        musicList: info.map((item) => {
            const split = (item.filename || "").split("-");
            return {
                id: String(item.hash),
                title: (split[1] || item.songname || "").trim(),
                artist: (split[0] || item.singername || "").trim(),
                album: item.album_name || item.remark,
                album_id: item.album_id,
                album_audio_id: item.album_audio_id,
                artwork: albumItem.artwork,
                "320hash": item.HQFileHash,
                sqhash: item.SQFileHash,
                origin_hash: item.id,
            };
        }),
    };
}

async function importMusicSheet(urlLike) {
    const match = String(urlLike || "").match(/^(?:.*?)(\d+)(?:.*?)$/);
    if (!match) throw new Error("无法识别酷狗码或歌单链接");
    const id = match[1];
    const command = await axios.post("http://t.kugou.com/command/", {
        appid: 1001, clientver: 9020, mid: "21511157a05844bd085308bc76ef3343", clienttime: 640612895,
        key: "36164c4015e704673c588ee202b9ecb8", data: id,
    });
    if (command.status !== 200 || command.data.status !== 1) throw new Error("酷狗码无效或已失效");
    const data = command.data.data;
    const response = await axios.post("http://www2.kugou.kugou.com/apps/kucodeAndShare/app/", {
        appid: 1001, clientver: 10112, mid: "70a02aad1ce4648e7dca77f2afa7b182", clienttime: 722219501,
        key: "381d7062030e8a5a94cfbe50bfe65433",
        data: { id: data.info.id, type: 3, userid: data.info.userid, collect_type: data.info.collect_type, page: 1, pagesize: data.info.count },
    });
    if (response.status !== 200 || response.data.status !== 1) throw new Error("无法读取酷狗歌单");
    const resource = response.data.data.map((song) => ({ album_audio_id: 0, album_id: "0", hash: song.hash, id: 0, name: song.filename.replace(".mp3", ""), page_id: 0, type: "audio" }));
    const result = await axios.post("https://gateway.kugou.com/v2/get_res_privilege/lite?appid=1001&clienttime=1668883879&clientver=10112&dfid=2O3jKa20Gdks0LWojP3ly7ck&mid=70a02aad1ce4648e7dca77f2afa7b182&userid=390523108&uuid=92691C6246F86F28B149BAA1FD370DF1", {
        appid: 1001, area_code: "1", behavior: "play", clientver: "10112", dfid: "2O3jKa20Gdks0LWojP3ly7ck", mid: "70a02aad1ce4648e7dca77f2afa7b182", need_hash_offset: 1, relate: 1, resource, token: "", userid: "0", vip: 0,
    }, { headers: { "x-router": "media.store.kugou.com" } });
    return (result.data.data || []).map((item) => ({
        id: String(item.hash), title: item.songname, artist: item.singername, album: item.albumname,
        album_id: item.album_id, album_audio_id: item.album_audio_id, artwork: item.info && imageUrl(item.info.image, 400),
        "320hash": item.relate_goods && item.relate_goods[1] && item.relate_goods[1].hash,
        sqhash: item.relate_goods && item.relate_goods[2] && item.relate_goods[2].hash,
        origin_hash: item.relate_goods && item.relate_goods[3] && item.relate_goods[3].hash,
    }));
}

module.exports = {
    platform: "小枸音乐",
    version: "0.3.1",
    author: "Huibq",
    appVersion: ">0.1.0-alpha.0",
    srcUrl: "https://fastly.jsdelivr.net/gh/Huibq/keep-alive/Music_Free/xiaogou.js",
    cacheControl: "no-cache",
    description: "酷狗音乐搜索与播放插件",
    primaryKey: ["id", "album_id", "album_audio_id"],
    hints: { importMusicSheet: ["支持酷狗 APP 的酷狗码或包含数字酷狗歌单链接。", "导入时间和歌单大小有关，请耐心等待。"] },
    supportedSearchType: ["music", "album", "sheet"],

    async search(query, page, type) {
        if (type === "music") return searchMusic(query, page || 1);
        if (type === "album") return searchAlbum(query, page || 1);
        if (type === "sheet") return searchMusicSheet(query, page || 1);
        return { isEnd: true, data: [] };
    },
    getMediaSource,
    getTopLists,
    getLyric,
    getTopListDetail,
    getAlbumInfo,
    importMusicSheet,
};
