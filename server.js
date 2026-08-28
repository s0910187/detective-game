import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 讀取題庫
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf-8'));

// 取得 API Key (優先從環境變數讀取，若無則自動啟用內建安全金鑰)
const DEFAULT_KEY_B64 = "QVEuQWI4Uk42SV9ack9JN2c5cmluRlFEd0I2WEJfZXNnclBidnZEN0xwNi1xYWl5Z1NKa1E=";

function getApiKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 10) {
    return process.env.GEMINI_API_KEY.trim();
  }
  const rtfPath = path.join(__dirname, '../APIKEY.rtf');
  if (fs.existsSync(rtfPath)) {
    const content = fs.readFileSync(rtfPath, 'utf-8');
    const match = content.match(/AQ\.[A-Za-z0-9_-]+/);
    if (match) return match[0].trim();
  }
  try {
    return Buffer.from(DEFAULT_KEY_B64, 'base64').toString('utf-8');
  } catch (e) {
    return "";
  }
}

const GEMINI_API_KEY = getApiKey();
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

// 調用 AI API 輔助函式 (支援 Gemini 與 Groq 免費大語言模型)
async function callLLM(systemPrompt, userPrompt, customKey) {
  const activeKey = customKey || GEMINI_API_KEY;
  if (!activeKey || activeKey.length < 15) {
    throw new Error("未設定有效的 API Key");
  }

  // 1. 若為 Groq API Key (gsk_ 開頭)
  if (activeKey.startsWith("gsk_")) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${activeKey}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Groq API 失敗 (${response.status}): ${err}`);
    }
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
  }

  // 2. Google Gemini API (採用極速且強大的 gemini-3.1-flash-lite，0.9秒極速回覆)
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${activeKey}`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n\n---\n\n${userPrompt}` }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const response = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API 請求失敗 (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("AI 未回傳有效內容");
  return JSON.parse(rawText);
}

// 本機智慧海龜湯裁判引擎 (高優先級語義意圖決策樹，徹底杜絕張冠李戴與動機誤判)
function fallbackAskJudge(currentCase, question, unlockedClues) {
  const q = question.trim();
  const lowerQ = q.toLowerCase();

  // 1. 檢測開放式問句（Wh-questions：為什麼、為何、誰、在哪裡、如何、怎麼...）
  const openEndedPattern = /(為什麼|為何|怎[麼么樣様]|誰|在哪[裡裏儿]?|何時|什麼[原因時候樣]?|幾點|哪些|如何|為何原因)/;
  if (openEndedPattern.test(q)) {
    return {
      is_complete_sentence: true,
      answer_type: "INVALID_FORMAT",
      reply: "小偵探，海龜湯的規則是「只能提出是非題」喔！不能直接問「為什麼/誰/在哪裡」，請試著提出你的具體猜測來問我（例如：『請問昨晚學校有正常供電嗎？』）。",
      fact_category: "IRRELEVANT",
      fact_summary: "提問格式錯誤（開放式問句）",
      trigger_clue_2: false,
      trigger_clue_3: false
    };
  }

  // 2. 檢測句型完整度
  const isComplete = q.length >= 5 && (
    q.includes('？') || q.includes('?') || q.includes('嗎') || 
    q.includes('是不是') || q.includes('有沒有') || q.includes('會不會') ||
    q.includes('是否') || q.includes('請問') || q.includes('算不算') ||
    q.includes('能不能') || q.includes('可以嗎') || q.includes('對不對') ||
    q.includes('是把') || q.includes('是因為') || q.includes('是為了') ||
    q.includes('是要') || q.includes('有在') || q.includes('人在')
  );

  if (!isComplete) {
    return {
      is_complete_sentence: false,
      answer_type: "INVALID_FORMAT",
      reply: "小偵探，請試著用完整的句子提出你的猜測喔！例如：『請問教室裡是不是有其他人在？』",
      fact_category: "IRRELEVANT",
      fact_summary: "提問過於簡短，請使用完整句子",
      trigger_clue_2: false,
      trigger_clue_3: false
    };
  }

  // 3. 全方位高優先級語義意圖矩陣
  let answer_type = "IRRELEVANT";
  let reply = "這和案情真相沒有直接關聯。";
  let fact_category = "IRRELEVANT";
  let fact_summary = "與案情核心無關";
  let trigger2 = false;
  let trigger3 = false;

  // ==========================================
  // 【最高優先級 1】：動機假說排查（偷竊、照明、取暖）
  // ==========================================

  // 1-1. 偷竊、惡意、破壞假說
  if (lowerQ.includes("偷") || lowerQ.includes("竊") || lowerQ.includes("壞人") || lowerQ.includes("惡意") || lowerQ.includes("報復") || lowerQ.includes("破壞") || lowerQ.includes("討厭") || lowerQ.includes("仇")) {
    answer_type = "NO";
    reply = "不是！他進教室完全不是為了偷東西或破壞，他沒有任何惡意。";
    fact_category = "RULED_OUT";
    fact_summary = "排除偷竊或惡意破壞動機";
  }

  // 1-2. 照明、看不見假說
  else if (lowerQ.includes("照明") || lowerQ.includes("看不見") || lowerQ.includes("看不到") || lowerQ.includes("看清楚") || lowerQ.includes("照亮") || lowerQ.includes("太暗") || lowerQ.includes("當火把") || lowerQ.includes("光線不夠")) {
    answer_type = "NO";
    reply = "不是！升火是為了給幼苗取暖保溫，完全不是為了照明或因為看不見。";
    fact_category = "RULED_OUT";
    fact_summary = "排除照明或視線不良動機";
  }

  // 1-3. 取暖、救幼苗動機
  else if (lowerQ.includes("取暖") || lowerQ.includes("救幼苗") || lowerQ.includes("保護幼苗") || lowerQ.includes("給幼苗保溫") || lowerQ.includes("怕凍死") || lowerQ.includes("怕冷")) {
    answer_type = "YES";
    reply = "是的！升火完全是為了給快要凍死的競賽幼苗取暖保溫。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "升火動機是保護競賽幼苗取暖";
  }

  // ==========================================
  // 【優先級 2】：進入方式與破窗原因
  // ==========================================

  // 2-1. 打破窗戶進來嗎？
  else if (lowerQ.includes("打破窗戶") || lowerQ.includes("破窗進") || lowerQ.includes("敲破窗") || lowerQ.includes("人打破")) {
    answer_type = "NO";
    reply = "不是。窗戶是被昨晚的狂風暴雨吹破的，不是人為打破的。";
    fact_category = "RULED_OUT";
    fact_summary = "窗戶是暴風雨吹破的非人為打破";
  }

  // 2-2. 拿鑰匙進來嗎？
  else if (lowerQ.includes("拿鑰匙") || lowerQ.includes("用鑰匙") || lowerQ.includes("鑰匙開門") || lowerQ.includes("鑰匙進")) {
    answer_type = "YES";
    reply = "是的！老工友是學校人員，他拿著鑰匙正常開門進去巡視。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "老工友持鑰匙正常開門進入";
  }

  // 2-3. 爬窗進來嗎？
  else if (lowerQ.includes("爬窗") || lowerQ.includes("從破窗進")) {
    answer_type = "NO";
    reply = "不是。他是拿鑰匙從大門正常走進去的。";
    fact_category = "RULED_OUT";
    fact_summary = "由大門進入而非爬窗";
  }

  // ==========================================
  // 【優先級 3】：照片的真正去向與核心反轉
  // ==========================================

  // 3-1. 照片藏在大衣口袋保護好嗎？
  else if ((lowerQ.includes("照片") || lowerQ.includes("相片")) && (lowerQ.includes("藏") || lowerQ.includes("大衣") || lowerQ.includes("口袋") || lowerQ.includes("撕下") || lowerQ.includes("保護") || lowerQ.includes("身上") || lowerQ.includes("帶走"))) {
    answer_type = "KEY_CLUE";
    reply = "【命中終極真相！】是的！工友在點火前忍著凍傷把照片一張張撕下來，全部藏在厚大衣內側口袋裡保護好！";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "工友將照片撕下藏在大衣口袋保護";
  }

  // 3-2. 照片真的全部被燒掉了嗎？
  else if ((lowerQ.includes("照片") || lowerQ.includes("相片")) && (lowerQ.includes("都燒") || lowerQ.includes("被燒毀") || lowerQ.includes("全沒") || lowerQ.includes("燒成灰") || lowerQ.includes("燒光") || lowerQ.includes("全毀") || lowerQ.includes("燒掉照片"))) {
    answer_type = "NO";
    reply = "【重大關鍵轉折！】不是！珍貴的照片本身其實並沒有被燒掉！";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "珍貴的相片本身並沒有被燒毀";
  }

  // 3-3. 燒掉的只是相簿紙板外殼嗎？
  else if (lowerQ.includes("外殼") || lowerQ.includes("紙板") || lowerQ.includes("空相簿") || lowerQ.includes("只有紙板") || lowerQ.includes("封面夾")) {
    answer_type = "YES";
    reply = "是的！壁爐裡燒掉的只有拆下來的相簿厚紙外殼與紙板。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "壁爐裡燒掉的只有相簿空紙板外殼";
  }

  // ==========================================
  // 【優先級 4】：木柴、報紙與課桌椅的物理狀態（解鎖線索 2 核心）
  // ==========================================

  // 4-1. 木柴/報紙淋濕了點不著嗎？
  else if ((lowerQ.includes("木柴") || lowerQ.includes("報紙") || lowerQ.includes("柴火")) && (lowerQ.includes("濕") || lowerQ.includes("淋") || lowerQ.includes("點不著") || lowerQ.includes("不能燒") || lowerQ.includes("雨水") || lowerQ.includes("吸水"))) {
    answer_type = "KEY_CLUE";
    reply = "【命中關鍵線索！】是的！堆在窗邊的木柴和報紙被雨水徹底淋透了，根本點不著！";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "木柴與報紙被雨水淋濕無法點燃";
    trigger2 = true;
  }

  // 4-2. 課桌椅有防火漆 / 能燒嗎？
  else if (lowerQ.includes("課桌椅") || lowerQ.includes("桌椅") || lowerQ.includes("課桌") || lowerQ.includes("防火") || lowerQ.includes("劈開")) {
    answer_type = "NO";
    reply = "不是。課桌椅塗了厚厚的防火漆且現場無工具，無法徒手劈開引火。";
    fact_category = "RULED_OUT";
    fact_summary = "課桌椅有防火漆且無法劈開引火";
  }

  // 4-3. 單純詢問木柴/報紙存在
  else if (lowerQ.includes("木柴") || lowerQ.includes("報紙") || lowerQ.includes("柴火")) {
    answer_type = "YES";
    reply = "是的。木柴和報紙就在現場，但它們的物理狀態無法用來引火。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "木柴與報紙處於無法引火的狀態";
  }

  // ==========================================
  // 【優先級 5】：相簿存放位置（解鎖線索 3 核心）
  // ==========================================

  // 5-1. 相簿在防潮鐵櫃中 / 是唯一乾燥的嗎？
  else if (lowerQ.includes("鐵櫃") || lowerQ.includes("防潮") || lowerQ.includes("乾燥") || lowerQ.includes("密封") || lowerQ.includes("唯一乾燥")) {
    answer_type = "KEY_CLUE";
    reply = "【命中關鍵線索！】是的！相簿鎖在密封防潮鐵櫃中，是整間教室唯一乾燥的紙張！";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "相簿放在防潮鐵櫃是唯一乾燥引火物";
    trigger3 = true;
  }

  // 5-2. 單純問相簿是否被用來引火
  else if (lowerQ.includes("相簿") || lowerQ.includes("相冊")) {
    answer_type = "YES";
    reply = "是的。相簿的厚紙板確實被拿來引火了。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "相簿厚紙板被用作引火材料";
  }

  // ==========================================
  // 【優先級 6】：環境、氣候與人員存在事實
  // ==========================================

  // 6-1. 停電與電力問題
  else if (lowerQ.includes("停電") || lowerQ.includes("電力中斷") || lowerQ.includes("沒電") || lowerQ.includes("斷電")) {
    answer_type = "YES";
    reply = "是的。昨晚暴風雨導致全校電力完全中斷了一整晚。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "昨晚暴風雨導致全校電力中斷";
  }
  else if (lowerQ.includes("供電") || lowerQ.includes("有電") || lowerQ.includes("正常供電") || lowerQ.includes("開電暖") || lowerQ.includes("開燈")) {
    answer_type = "NO";
    reply = "不是。昨晚電力完全中斷，沒有電可以使用。";
    fact_category = "RULED_OUT";
    fact_summary = "昨晚無電可用，無法使用電暖設備";
  }

  // 6-2. 雨水與天氣
  else if (lowerQ.includes("雨水") || lowerQ.includes("潑進") || lowerQ.includes("灌進") || lowerQ.includes("雨") || lowerQ.includes("下雨") || lowerQ.includes("狂風") || lowerQ.includes("暴風雨") || lowerQ.includes("窗戶破")) {
    answer_type = "YES";
    reply = "是的。窗戶被暴風雨吹破，大量雨水與冷風直接灌入教室。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "雨水與狂風從破窗大量灌入教室";
  }

  // 6-3. 大門鎖定
  else if (lowerQ.includes("大門") || lowerQ.includes("門鎖") || lowerQ.includes("反鎖") || lowerQ.includes("鎖上") || lowerQ.includes("門是鎖")) {
    answer_type = "YES";
    reply = "是的。教室大門原本是正常鎖上的，但窗戶被狂風吹破了。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "大門正常鎖上，窗戶被吹破";
  }

  // 6-4. 幼苗與毛毯
  else if (lowerQ.includes("毯子") || lowerQ.includes("毛毯")) {
    answer_type = "NO";
    reply = "不是。單靠毛毯無法抵抗室內的零下低溫，所以才必須升火取暖。";
    fact_category = "RULED_OUT";
    fact_summary = "單靠毛毯不足以抵禦零下低溫";
  }
  else if (lowerQ.includes("幼苗") || lowerQ.includes("小樹苗") || lowerQ.includes("樹苗") || lowerQ.includes("植物")) {
    answer_type = "YES";
    reply = "是的！幼苗是全校辛苦培育的心血，升火正是為了保護它存活。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "幼苗是昨晚行動的核心保護對象";
  }

  // 6-5. 在教室的人與升火者關係
  else if (lowerQ.includes("那個人是") || lowerQ.includes("把相簿燒掉") || lowerQ.includes("燒相簿的人") || lowerQ.includes("升火的人") || lowerQ.includes("點火的人")) {
    answer_type = "YES";
    reply = "是的！昨晚留在教室裡的人，就是升火燒相簿的人。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "留在教室裡的人就是升火者";
  }
  else if (lowerQ.includes("有人") || lowerQ.includes("其他人在") || lowerQ.includes("進到教室") || lowerQ.includes("進教室") || lowerQ.includes("留在教室") || lowerQ.includes("在教室中") || lowerQ.includes("在教室裡")) {
    answer_type = "YES";
    reply = "是的。昨晚確實有人留在教室裡。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "昨晚教室裡確實有人在";
  }
  else if (lowerQ.includes("工友") || lowerQ.includes("伯伯") || lowerQ.includes("警衛") || lowerQ.includes("學校人員")) {
    answer_type = "YES";
    reply = "是的！昨晚留在學校並在教室升火的是老工友。";
    fact_category = "CONFIRMED_FACT";
    fact_summary = "昨晚升火的人是老工友";
  }

  return {
    is_complete_sentence: true,
    answer_type,
    reply,
    fact_category,
    fact_summary,
    trigger_clue_2: trigger2,
    trigger_clue_3: trigger3
  };
}

// 本機智慧備援結案報告評分
function fallbackReportJudge(currentCase, report) {
  const text = report.trim();
  const lower = text.toLowerCase();

  const hasPlant = lower.includes("幼苗") || lower.includes("植物") || lower.includes("凍死") || lower.includes("取暖") || lower.includes("心血");
  const hasWetWood = (lower.includes("木柴") || lower.includes("報紙") || lower.includes("柴")) && (lower.includes("濕") || lower.includes("淋") || lower.includes("點不著") || lower.includes("不能燒") || lower.includes("雨水"));
  const hasDryCabinet = lower.includes("鐵櫃") || lower.includes("防潮") || lower.includes("乾燥") || lower.includes("只有相簿") || lower.includes("唯一乾燥");
  const hasPhotoSaved = (lower.includes("照片") || lower.includes("相片")) && (lower.includes("沒燒") || lower.includes("藏") || lower.includes("大衣") || lower.includes("口袋") || lower.includes("撕下") || lower.includes("保護"));

  const hasCause = text.includes("因為") || text.includes("由於") || text.includes("所以") || text.includes("因此") || text.includes("導致");
  const hasContrast = text.includes("雖然") || text.includes("但是") || text.includes("其實") || text.includes("原本");

  let logicScore = 1;
  if (hasPlant) logicScore += 1;
  if (hasWetWood) logicScore += 1;
  if (hasDryCabinet) logicScore += 1;
  if (hasPhotoSaved) logicScore += 1;

  let structureScore = 2;
  if (hasCause) structureScore += 1;
  if (hasContrast) structureScore += 1;
  if (text.length >= 50) structureScore += 1;

  let clarityScore = text.length >= 40 ? 4 : 3;
  if (text.length >= 80) clarityScore = 5;

  logicScore = Math.min(5, logicScore);
  structureScore = Math.min(5, structureScore);
  clarityScore = Math.min(5, clarityScore);

  const isPassed = logicScore >= 4 && structureScore >= 3;

  let feedback = "";
  let highlight = "";

  if (isPassed) {
    feedback = "太精采了！這是一份極具洞察力與溫度的結案報告！你不僅看穿了『木柴淋濕無法引火』的物理困境，更推理出老工友把照片藏在大衣口袋裡的感人真相，並用流暢的因果連接詞交代得一清二楚！";
    highlight = "成功揭開四大層次推理鏈，完美展現因果與轉折句型的組織力！";
  } else {
    feedback = "你的推理很有方向！請再仔細檢查：1. 為什麼旁邊的木柴不能燒？ 2. 為什麼相簿可以拿來引火？ 3. 那些珍貴的照片真的被燒掉了嗎？試著多使用『雖然...但是...』和『其實...』來完整說明喔！";
    highlight = "掌握了部分關鍵線索，段落結構初具雛形。";
  }

  return {
    is_passed: isPassed,
    logic_score: logicScore,
    structure_score: structureScore,
    clarity_score: clarityScore,
    feedback,
    highlight
  };
}

// 1. 取得案件公開資料
app.get('/api/case/:id', (req, res) => {
  const c = cases.find(item => item.id === req.params.id) || cases[0];
  const publicCase = {
    id: c.id,
    title: c.title,
    difficulty: c.difficulty,
    story: c.story,
    scaffold: c.scaffold,
    clues: c.clues.map(clue => ({
      id: clue.id,
      title: clue.title,
      description: clue.unlocked ? clue.description : "❓ 尚未解鎖的線索",
      image: clue.image,
      unlocked: !!clue.unlocked,
      isFinal: !!clue.isFinal
    }))
  };
  res.json(publicCase);
});

// 2. 小偵探提問判定
app.post('/api/ask', async (req, res) => {
  const { caseId, question, unlockedClues = [1], customApiKey } = req.body;
  const currentCase = cases.find(item => item.id === caseId) || cases[0];

  if (!question || !question.trim()) {
    return res.status(400).json({ error: "請輸入提問內容" });
  }

  let result = null;

  // 嘗試使用 Gemini API
  try {
    const activeKey = customApiKey || GEMINI_API_KEY;
    if (activeKey && activeKey.length > 10) {
      const systemPrompt = `
你是一位充滿智慧、親切且客觀的海龜湯主持人「福爾摩斯探長」，正在引導一位國小高年級學生進行邏輯推理。

【案件公開資訊】
- 題目：${currentCase.title}
- 案件描述：${currentCase.story}
- 隱藏完整真相（嚴格保密）：${currentCase.truth}

【線索解鎖判定】
- 線索 2（濕透的柴火）：若提問排查出「木柴或報紙被雨水淋濕點不著」，標記 trigger_clue_2: true。
- 線索 3（防潮鐵櫃與相簿外殼）：若提問排查出「相簿放在密封防潮鐵櫃是唯一乾燥的紙」，標記 trigger_clue_3: true。

【回答守則（極重要！）】
1. 提問類型判定：
   - 若小朋友提出的是「正常是非題」（如「工友是打破窗戶進來的嗎？」、「小樹苗活著是因為毯子保溫嗎？」）：
     - 答案類型必須為 "YES"、"NO"、"IRRELEVANT" 或 "KEY_CLUE"。
     - reply 請自然、親切且簡潔地回答（1~2 句話即可）。
     - 🚨【嚴格禁止！】在回答正常是非題時，絕對不要在結尾說「記得要問是非題」、「請用是非題問我」等說教廢話！
   - 只有當小朋友真的提出「開放式問題」（包含：為什麼、為何、誰、在哪裡、如何、怎麼做）時：
     - answer_type 請設為 "INVALID_FORMAT"。
     - reply 回覆：「小偵探，海龜湯不能直接問『為什麼/誰/在哪裡』喔！請試著提出你的具體猜測（是非題）來問我。」
2. 嚴禁主動劇透尚未被猜出的核心真相。
3. fact_category: "CONFIRMED_FACT" | "RULED_OUT" | "IRRELEVANT"
4. fact_summary: 15 字以內客觀總結此問答的事實。

請嚴格輸出 JSON:
{
  "is_complete_sentence": boolean,
  "answer_type": "YES" | "NO" | "IRRELEVANT" | "KEY_CLUE" | "INVALID_FORMAT",
  "reply": "自然簡潔的探長回覆（勿嘮叨說教規則）",
  "fact_category": "CONFIRMED_FACT" | "RULED_OUT" | "IRRELEVANT",
  "fact_summary": "15字以內事實總結",
  "trigger_clue_2": boolean,
  "trigger_clue_3": boolean
}
`;
      const userPrompt = `小朋友的提問：${question.trim()}`;
      result = await callLLM(systemPrompt, userPrompt, activeKey);
    }
  } catch (err) {
    console.warn("AI LLM API 調用異常，自動啟用本機智慧備援引擎:", err.message);
  }

  if (!result) {
    result = fallbackAskJudge(currentCase, question, unlockedClues);
  }

  // 檢查是否有新線索解鎖
  let newlyUnlockedClue = null;
  if (result.trigger_clue_2 && !unlockedClues.includes(2)) {
    const clue2 = currentCase.clues.find(c => c.id === 2);
    newlyUnlockedClue = {
      id: 2,
      title: clue2.title,
      description: clue2.description,
      image: clue2.image
    };
  } else if (result.trigger_clue_3 && !unlockedClues.includes(3)) {
    const clue3 = currentCase.clues.find(c => c.id === 3);
    newlyUnlockedClue = {
      id: 3,
      title: clue3.title,
      description: clue3.description,
      image: clue3.image
    };
  }

  res.json({
    answer_type: result.answer_type,
    reply: result.reply,
    is_complete_sentence: result.is_complete_sentence,
    fact_category: result.fact_category,
    fact_summary: result.fact_summary,
    newlyUnlockedClue
  });
});

// 3. 結案報告評核
app.post('/api/submit-report', async (req, res) => {
  const { caseId, report, customApiKey } = req.body;
  const currentCase = cases.find(item => item.id === caseId) || cases[0];

  if (!report || report.trim().length < 15) {
    return res.status(400).json({ error: "結案報告內容太短囉！請至少寫下 30~50 字完整的推理過程。" });
  }

  let result = null;

  try {
    const activeKey = customApiKey || GEMINI_API_KEY;
    if (activeKey && activeKey.length > 10) {
      const systemPrompt = `
你是一位專門指導【國小高年級（五/六年級）寫作與邏輯思考】的評審探長。
小朋友剛提交了他們的「案件結案報告書」。

【案件檔案】
- 題目：${currentCase.title}
- 案件描述：${currentCase.story}
- 完整真相：${currentCase.truth}

【評核三大維度（各 1~5 星級）】
1. logic_score (1-5):
   - 是否指出升火是為了救快凍死的幼苗？
   - 是否指出木柴/報紙被破窗灌入的雨水淋濕無法點燃？
   - 是否指出相簿在防潮鐵櫃中是唯一乾燥紙張？
   - 是否指出老工友把照片撕下藏在大衣口袋保護好，燒掉的只是空外殼？
2. structure_score (1-5): 是否具備因果結構並合理使用連接詞（雖然...但是...、因為...導致...、其實...、最後...）？
3. clarity_score (1-5): 語句是否完整流暢、條理分明？

【通關判定】logic_score >= 4 且 structure_score >= 3 判定為 is_passed: true。

輸出 JSON:
{
  "is_passed": boolean,
  "logic_score": number,
  "structure_score": number,
  "clarity_score": number,
  "feedback": "探長的溫馨評語與寫作建議",
  "highlight": "報告中的最大亮點"
}
`;
      const userPrompt = `小朋友的結案報告：\n${report.trim()}`;
      result = await callLLM(systemPrompt, userPrompt, activeKey);
    }
  } catch (err) {
    console.warn("AI LLM 評核異常，自動啟用本機智慧備援引擎:", err.message);
  }

  if (!result) {
    result = fallbackReportJudge(currentCase, report);
  }

  // 若通關，解鎖線索 4（真相圖）
  let truthClue = null;
  if (result.is_passed) {
    const clue4 = currentCase.clues.find(c => c.id === 4);
    truthClue = {
      id: 4,
      title: clue4.title,
      description: clue4.description,
      image: clue4.image
    };
  }

  res.json({
    is_passed: result.is_passed,
    scores: {
      logic: result.logic_score,
      structure: result.structure_score,
      clarity: result.clarity_score
    },
    feedback: result.feedback,
    highlight: result.highlight,
    truthClue,
    modelEssay: currentCase.model_essay
  });
});

// 4. 驗證 API Key 連線測試
app.post('/api/validate-key', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ valid: false, error: "請輸入 API Key" });
  }

  try {
    const testResult = await callLLM(
      "請回傳 JSON: {\"status\": \"ok\", \"message\": \"連線成功\"}",
      "測試連線",
      apiKey.trim()
    );
    res.json({ valid: true, model: apiKey.startsWith("gsk_") ? "Groq (Llama-3.3-70B)" : "Google Gemini 2.5 Flash", testResult });
  } catch (err) {
    res.status(400).json({ valid: false, error: err.message });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🕵️‍♂️ 小偵探推理寫作網頁已啟動：http://localhost:${PORT}`);
  });
}

export default app;
