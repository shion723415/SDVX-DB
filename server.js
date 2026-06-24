require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 인증 설정
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: 'http://localhost:3000/auth/discord/callback',
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

// 🔐 인증 라우터
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/api/user', (req, res) => req.isAuthenticated() ? res.json({ loggedIn: true, user: req.user }) : res.json({ loggedIn: false }));
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

// 🗄️ 모델 정의
const Score = mongoose.model('Score', new mongoose.Schema({}, { strict: false }));
const MusicData = mongoose.model('MusicData', new mongoose.Schema({ id: String, songs: Array }));

let musicDB = [];
let musicDBReady = false;

// 🌐 데이터 캐싱 및 초기화 로직
async function initServer() {
    console.log('🌐 곡 데이터를 준비합니다...');
    try {
        let cachedMusic = await MusicData.findOne({ id: "sdvx_music_db" });
        
        if (!cachedMusic) {
            console.log('🚀 DB 캐시 없음, 최신 곡 데이터를 다운로드합니다...');
            const response = await fetch('https://dp4p6x0xfi5o9.cloudfront.net/sdvx/data.json');
            const newData = await response.json();
            await MusicData.updateOne({ id: "sdvx_music_db" }, { $set: { id: "sdvx_music_db", songs: newData.songs } }, { upsert: true });
            musicDB = newData.songs;
            console.log(`✅ ${musicDB.length}개의 곡 데이터를 새로 저장했습니다.`);
        } else {
            console.log('✅ DB 캐시에서 곡 데이터를 로드했습니다.');
            musicDB = cachedMusic.songs;
        }
        musicDBReady = true;
    } catch (error) {
        console.error('🚨 곡 데이터 로드 실패:', error.message);
        const fallback = await MusicData.findOne({ id: "sdvx_music_db" });
        if (fallback) { musicDB = fallback.songs; musicDBReady = true; }
    }
}

// 관리자 갱신용 라우터
app.get('/api/refresh-music', async (req, res) => {
    await MusicData.deleteOne({ id: "sdvx_music_db" });
    await initServer();
    res.json({ success: true, message: "곡 데이터가 갱신되었습니다!" });
});

// 기존 로직들
const DIFF_TO_DB = { NOV: 'novice', ADV: 'advanced', EXH: 'exhaust', MXM: 'maximum', ULT: 'ultimate' };
const INF_VARIANTS = ['infinite', 'gravity', 'heavenly', 'vivid', 'exceed', 'navla', 'nabla'];
function normalize(title) {
    if (!title) return '';
    return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
        .replace(/[\s\-_~～'"’`《》()\[\]{}【】!！?？★☆◆◇♥♡:：;；,.\/\\&＆=]/g, '');
}

async function waitForInit(req, res, next) { if (!musicDBReady) await initPromise; next(); }
let initPromise = initServer();

app.get('/api/music', waitForInit, (req, res) => res.json(musicDB));
app.get('/api/scores', async (req, res) => {
    const searchId = req.isAuthenticated() ? req.user.id : "local_user";
    try {
        const scores = await Score.find({ userId: searchId });
        res.json(scores);
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/scores', waitForInit, async (req, res) => {
    const incoming = req.body;
    const targetUserId = req.query.userId || "local_user";
    const enriched = incoming.map(scoreData => {
        const foundMusic = musicDB.find(m => normalize(m.title) === normalize(scoreData.songTitle));
        let level = null;
        if (foundMusic) {
            scoreData.songTitle = foundMusic.title;
            let sheet;
            if (scoreData.difficulty === 'INF') sheet = foundMusic.sheets.find(s => INF_VARIANTS.includes(s.difficulty?.toLowerCase()));
            else if (scoreData.difficulty === 'ULT') sheet = foundMusic.sheets.find(s => s.difficulty?.toLowerCase() === 'ultimate');
            else {
                const target = DIFF_TO_DB[scoreData.difficulty];
                if (target) sheet = foundMusic.sheets.find(s => s.difficulty?.toLowerCase() === target.toLowerCase());
            }
            if (sheet) level = parseFloat(sheet.level);
        }
        return { ...scoreData, level, userId: targetUserId };
    });

    try {
        const bulkOps = enriched.map(s => ({
            updateOne: {
                filter: { userId: targetUserId, songTitle: s.songTitle, difficulty: s.difficulty },
                update: { $set: s },
                upsert: true
            }
        }));
        if (bulkOps.length > 0) await Score.bulkWrite(bulkOps);
        res.json({ success: true, message: '기록 업데이트 성공!' });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/delete-scores', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });

    try {
        // 내 디스코드 ID와 일치하는 모든 스코어 삭제
        const result = await Score.deleteMany({ userId: req.user.id });
        console.log(`🗑️ 유저 ${req.user.id}의 기록 ${result.deletedCount}건 삭제됨`);
        res.json({ success: true, message: `총 ${result.deletedCount}개의 기록이 삭제되었습니다.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ 클라우드 MongoDB에 성공적으로 연결되었습니다!');
        app.listen(PORT, () => console.log(`🚀 서버 실행 중: http://localhost:${PORT}`));
    })
    .catch(err => console.error('🚨 MongoDB 연결 실패:', err.message));