(async function() {
    //  북마크릿(인젝터)이 넘겨준 디스코드 ID를 가져옵니다.
    const userId = window.SDVX_USER_ID;
    if (!userId) {
        alert("유저 정보를 찾을 수 없습니다. 마이페이지에서 갱신 코드를 다시 발급받아주세요.");
        return;
    }

    const BASE_URL = "https://p.eagate.573.jp/game/sdvx/vii/playdata/";
    const MUSIC_PATH = "musicdata/index.html";
    // 내 디스코드 ID를 담아서 서버로 쏩니다
    const SEND_TO = `http://localhost:3000/api/scores?userId=${userId}`; 
    
    const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min) + min);
    const fetchHTML = async url => {
        const response = await fetch(url, { credentials: "include" });
        return response.text();
    };

    let myScoreData = [];
    const toolBg = document.createElement("div");
    toolBg.style.cssText = "position:fixed;top:0;z-index:10000;width:100%;height:100%;background:rgba(0,0,0,0.8);color:white;padding:20px;font-size:20px;";
    toolBg.innerHTML = "<div id='infoSpan'>나의 성과 데이터를 수집합니다...</div>";
    document.body.appendChild(toolBg);
    const infoSpan = document.getElementById("infoSpan");

    try {
        infoSpan.innerText = "1페이지 분석 중...";
        const firstPageHTML = await fetchHTML(`${BASE_URL}${MUSIC_PATH}?page=1&sort=0`);
        const parser = new DOMParser();
        let doc = parser.parseFromString(firstPageHTML, 'text/html');
        const select = doc.querySelector('#search_page');
        const maxPage = select ? Number(select.options[select.options.length - 1].value) + 1 : 1;

        for (let k = 1; k <= maxPage; k++) {
            infoSpan.innerText = `데이터 수집 중... (${k}/${maxPage})`;
            const pageHTML = await fetchHTML(`${BASE_URL}${MUSIC_PATH}?page=${k}&sort=0`);
            const pageDoc = parser.parseFromString(pageHTML, 'text/html');
            const rows = pageDoc.querySelectorAll('tr.data_col');
            
            rows.forEach(row => {
                const titleDiv = row.querySelector('.music .title');
                const songTitle = titleDiv ? titleDiv.textContent.trim() : "Unknown";
                const difficulties = ['nov', 'adv', 'exh', 'mxm', 'inf', 'ult'];
                
                difficulties.forEach(diff => {
                    const cell = row.querySelector(`td.${diff}`);
                    if (!cell) return;
                    const scoreText = cell.textContent.replace(/[^0-9]/g, '');
                    const score = parseInt(scoreText, 10);
                    if (!score || score === 0) return;
                    
                    let clearMedal = "PLAYED";
                    const imgs = cell.querySelectorAll('img');
                    let markImg = null;
                    imgs.forEach(img => { if (img.getAttribute('src').includes('mark')) markImg = img; });
                    
                    if (markImg) {
                        const src = markImg.getAttribute('src');
                        if (src.includes('per')) clearMedal = "PUC";
                        else if (src.includes('uc')) clearMedal = "UC";
                        else if (src.includes('comp_max')) clearMedal = "MAXXIVE";
                        else if (src.includes('comp_ex')) clearMedal = "EXC";
                        else if (src.includes('comp')) clearMedal = "CLEAR";
                        else if (src.includes('play')) clearMedal = "CRASH";
                        else clearMedal = src.split('/').pop();
                    }
                    myScoreData.push({ songTitle: songTitle, difficulty: diff.toUpperCase(), score: score, clearMedal: clearMedal });
                });
            });
            if (k < maxPage) await _sleep(getRandomInt(500, 1000));
        }

        infoSpan.innerText = "데이터를 저장하는 중...";
        await fetch(SEND_TO, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(myScoreData)
        });

        infoSpan.innerText = "전송 완료! 성과표 웹페이지를 새로고침 해보세요.";
        setTimeout(() => document.body.removeChild(toolBg), 3000);
    } catch (error) {
        console.error(error);
        infoSpan.innerText = "에러가 발생했습니다.";
    }
})();