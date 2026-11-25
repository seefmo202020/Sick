import type { KeywordTag, TitleCandidate, VideoChapter } from "@/db/schema";
import { buildGeneratedCaptions } from "./captions";
import { calculateSeoBreakdown, formatDuration } from "./youtube-constants";

export interface AnalyzeVideoInput {
  filename: string;
  userPrompt: string;
  transcriptHint: string;
  durationSeconds: number;
  language: string;
  categoryId: string;
  contentTone: string;
  channelTitle?: string;
  variationSeed?: string;
}

export interface AnalyzeVideoResult {
  aiProviderUsed: "tubesmart";
  detectedTopic: string;
  detectedAudience: string;
  bestPublishTime: string;
  focusKeyword: string;
  extractedKeywords: string[];
  suggestedCategoryId: string;
  suggestedLanguage: string;
  title: string;
  titleCandidates: TitleCandidate[];
  description: string;
  chapters: VideoChapter[];
  hashtags: string[];
  tags: KeywordTag[];
  seoScore: number;
  captions: Array<{
    languageCode: string;
    languageName: string;
    cues: ReturnType<typeof buildGeneratedCaptions>["cues"];
    srtContent: string;
  }>;
}

const YEAR = new Date().getFullYear();

/* ------------------------------------------------------------------ */
/* Deterministic pseudo-random (so "re-analyze" gives fresh angles)    */
/* ------------------------------------------------------------------ */

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function makeRng(seed: string) {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/* ------------------------------------------------------------------ */
/* Arabic + English aware text analysis                                */
/* ------------------------------------------------------------------ */

const AR_STOPWORDS = new Set([
  "في", "من", "على", "إلى", "عن", "مع", "هذا", "هذه", "ذلك", "تلك", "التي", "الذي",
  "الذين", "ما", "لا", "هو", "هي", "أن", "إن", "كان", "كانت", "قد", "كل", "بعض",
  "بين", "حتى", "عند", "عندما", "إذا", "لو", "أو", "و", "ثم", "لكن", "بل", "أي",
  "كيف", "ماذا", "لماذا", "متى", "أين", "منذ", "خلال", "بعد", "قبل", "فوق", "تحت",
  "جدا", "فقط", "ايضا", "أيضاً", "هنا", "هناك", "يكون", "تكون", "نحو", "حول",
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "is", "are",
  "be", "this", "that", "it", "as", "at", "by", "from", "you", "your", "we", "our",
]);

const FILLER_TOKENS = new Set([
  "mp4", "mov", "mkv", "webm", "avi", "m4v", "final", "export", "copy", "raw",
  "hd", "fhd", "uhd", "4k", "1080p", "720p", "vid", "video", "clip", "record",
  "rec", "screen", "capture", "img", "test", "sample", "untitled", "new",
]);

function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670]/g, "") // diacritics
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه");
}

function tokenize(text: string): string[] {
  return normalizeArabic(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    // Strip Arabic conjunction/definite prefixes so "وهاشتاجات" → "هاشتاجات"
    .map((t) => (t.length > 4 ? t.replace(/^(و|ف|ب|ك|ل|ال)+/, "") : t))
    .filter(
      (t) =>
        t.length >= 3 &&
        !AR_STOPWORDS.has(t) &&
        !FILLER_TOKENS.has(t) &&
        !/^\d+$/.test(t)
    );
}

/** Extract the most meaningful terms from the transcript/prompt (TF scoring). */
function extractKeywords(text: string, limit = 12): string[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  // Also count bigrams (long-tail phrases people actually search for)
  const bigrams = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = `${tokens[i]} ${tokens[i + 1]}`;
    bigrams.set(key, (bigrams.get(key) || 0) + 1);
  }

  const scoredUnigrams = [...freq.entries()]
    .map(([word, count]) => ({
      word,
      // Prefer repeated but not overly common words, and slightly longer words
      score: count * (1 + Math.min(word.length, 12) / 24),
    }))
    .filter((s) => s.score > 1.05)
    .sort((a, b) => b.score - a.score);

  const scoredBigrams = [...bigrams.entries()]
    .filter(([, count]) => count >= 2)
    .map(([phrase, count]) => ({ word: phrase, score: count * 2.1 }))
    .sort((a, b) => b.score - a.score);

  const merged = [...scoredBigrams.slice(0, 4), ...scoredUnigrams]
    .map((s) => s.word)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, limit);

  return merged;
}

interface DomainProfile {
  domain: string;
  categoryId: string;
  audience: string;
  bestTime: string;
  coreTopicFallback: string;
  hashtags: string[];
  longTailTemplates: string[];
  playlist: string;
  titleFormulas: Array<{ angle: string; reason: string; build: (t: string) => string }>;
}

function detectDomain(text: string): DomainProfile {
  const lower = text.toLowerCase();

  if (/(ubuntu|node|nodejs|linux|github|server|vps|deploy|nginx|docker|برمج|كود|سيرفر|نود|اوبونتو|لينكس|موقع|تطبيق|جيتهب|react|next|python|javascript|api|قاعدة بيانات|sql)/i.test(lower)) {
    return {
      domain: "programming",
      categoryId: "28",
      audience: "المبرمجون ومطورو الويب وصنّاع التطبيقات العرب",
      bestTime: "الخميس 8:00 مساءً بتوقيت القاهرة",
      coreTopicFallback: "رفع وتشغيل المواقع على سيرفر أوبونتو باستخدام Node.js",
      hashtags: ["برمجة", "تطوير_الويب", "اوبونتو", "NodeJS", "GitHub", "تقنية", "شروحات_تقنية"],
      longTailTemplates: [
        `شرح {k} خطوة بخطوة للمبرمجين المبتدئين ${YEAR}`,
        `كيفية {k} بدون اخطاء على سيرفر حقيقي`,
        `افضل طريقة لاعداد {k} وتشغيله بسرعة`,
        `حل مشاكل {k} الشائعة واسبابها`,
        `{k} من الصفر الى الاحتراف عمليا`,
        `رفع موقع node js على سيرفر اوبونتو ${YEAR}`,
        `شرح تثبيت nodejs و pm2 على ubuntu`,
        `اعداد nginx وشهادة ssl لموقع node js`,
      ],
      playlist: "شروحات البرمجة والسيرفرات",
      titleFormulas: [
        { angle: "تصدر البحث التقني", reason: "يحتوي الكلمات البحثية المستهدفة بدقة + السنة الحديثة", build: (t) => `${t} خطوة بخطوة (${YEAR})` },
        { angle: "أعلى نسبة نقر", reason: "وعد واضح بنتيجة + مدة زمنية تشجع على المشاهدة للنهاية", build: (t) => `أسهل طريقة لـ ${t} في دقائق معدودة!` },
        { angle: "صيغة سؤال بحثية", reason: "أسئلة (كيف) تلتقط بحث يوتيوب وجوجل المباشر", build: (t) => `كيف تنفّذ ${t} بشكل صحيح من أول مرة؟` },
        { angle: "قيمة عملية عالية", reason: "يركز على الأخطاء التي يقع فيها الجميع", build: (t) => `${t} — الأخطاء التي تضيّع وقتك وكيف تتجنبها` },
        { angle: "دليل شامل", reason: "يصف الفيديو كمرجع كامل يرفع وقت المشاهدة", build: (t) => `${t}: الدليل العملي الكامل للمبتدئين والمحترفين` },
      ],
    };
  }

  if (/(youtube|يوتيوب|سيو|seo|مشاهدات|مشترك|قناة|ادسنس|عنوان|تاجز|فيديو|مونتاج|تريند|خوارزم)/i.test(lower)) {
    return {
      domain: "youtube",
      categoryId: "27",
      audience: "صنّاع المحتوى وأصحاب قنوات يوتيوب المبتدئون والمحترفون",
      bestTime: "الأربعاء 7:00 مساءً بتوقيت القاهرة",
      coreTopicFallback: "تصدر نتائج بحث يوتيوب وزيادة المشاهدات بأحدث الطرق",
      hashtags: ["يوتيوب", "سيو_اليوتيوب", "صناعة_المحتوى", "زيادة_المشاهدات", "الربح_من_اليوتيوب", "YouTubeSEO"],
      longTailTemplates: [
        `كيفية تصدر نتائج البحث في اليوتيوب ${YEAR}`,
        `افضل طريقة لزيادة مشاهدات اليوتيوب بسرعة للمبتدئين`,
        `اختيار الكلمات المفتاحية القوية لفيديوهات اليوتيوب`,
        `طريقة كتابة عنوان ووصف احترافي لفيديو يوتيوب`,
        `اسرار سيو اليوتيوب لرفع المشاهدات والمشتركين`,
        `{k} لزيادة مشاهدات قناتك مجانا`,
        `كيف تجعل فيديوهاتك تظهر في الصفحة الاولى`,
        `افضل اداة لتحسين {k} على اليوتيوب`,
      ],
      playlist: "أسرار نمو قنوات اليوتيوب والسيو",
      titleFormulas: [
        { angle: "تصدر البحث الأول", reason: "الكلمة المفتاحية في البداية + سنة البحث لالتقاط أعلى زيارات", build: (t) => `${t} — الطريقة الكاملة (${YEAR})` },
        { angle: "أعلى نسبة نقر (CTR)", reason: "وعد مضاعفة النتيجة يرفع نسبة الضغط بشكل كبير", build: (t) => `${t}: ضاعف مشاهداتك بهذه الطريقة المجربة!` },
        { angle: "فضول وتشويق", reason: "صيغة (سر) تدفع المشاهد للضغط لمعرفة الإجابة", build: (t) => `السر الذي لا يخبرك به أحد عن ${t}` },
        { angle: "بحث عام عالي", reason: "صيغة (كيف تبدأ) الأكثر طلباً عربياً", build: (t) => `كيف تبدأ ${t} من الصفر حتى الاحتراف` },
        { angle: "قائمة أرقام", reason: "الأرقام المحددة تزيد النقر حتى 28% في الصفحة الرئيسية", build: (t) => `7 خطوات عملية لإتقان ${t} اليوم` },
      ],
    };
  }

  if (/(ai|ذكاء|اصطناع|chat|بوت|أتمتة|توليد|ادوات ذكاء|prompt|برومبت)/i.test(lower)) {
    return {
      domain: "ai",
      categoryId: "28",
      audience: "المهتمون بالذكاء الاصطناعي وأدوات الإنتاجية والعمل عبر الإنترنت",
      bestTime: "الأحد 7:30 مساءً بتوقيت القاهرة",
      coreTopicFallback: "أقوى أدوات الذكاء الاصطناعي لزيادة الإنتاجية وصناعة المحتوى",
      hashtags: ["الذكاء_الاصطناعي", "AI", "أدوات_ذكاء_اصطناعي", "تقنية", "صناعة_المحتوى", "مستقبل_التقنية"],
      longTailTemplates: [
        `افضل ادوات الذكاء الاصطناعي المجانية ${YEAR}`,
        `شرح استخدام الذكاء الاصطناعي للمبتدئين خطوة بخطوة`,
        `انشاء محتوى احترافي بالذكاء الاصطناعي مجانا`,
        `اسرار الذكاء الاصطناعي لزيادة الانتاجية وتوفير الوقت`,
        `{k} بالذكاء الاصطناعي بطريقة احترافية`,
        `مقارنة اقوى مواقع الذكاء الاصطناعي باللغة العربية`,
        `كيف تستخدم {k} في مشروعك القادم`,
      ],
      playlist: "دليل الذكاء الاصطناعي العملي",
      titleFormulas: [
        { angle: "تريند عالي البحث", reason: "الذكاء الاصطناعي + السنة = أعلى حجم بحث حالياً", build: (t) => `${t} بأدوات الذكاء الاصطناعي (${YEAR})` },
        { angle: "أعلى نسبة نقر", reason: "فائدة ملموسة (توفير الوقت) تدفع للنقر", build: (t) => `${t} — وفّر ساعات من عملك بهذه الأدوات!` },
        { angle: "شرح عملي", reason: "يعد بتطبيق مباشر وليس كلاماً نظرياً", build: (t) => `شرح عملي: ${t} خطوة بخطوة` },
        { angle: "فضول وتشويق", reason: "صيغة (لن تصدق) ترفع الفضول والنقر", build: (t) => `لن تصدق نتيجة ${t} قبل أن تجربها بنفسك` },
        { angle: "دليل شامل", reason: "مرجع كامل لكل من يبدأ في المجال", build: (t) => `كل ما تحتاج معرفته عن ${t} في فيديو واحد` },
      ],
    };
  }

  if (/(game|gaming|لعبة|ألعاب|ببجي|فيفا|ماين|بلايستيشن|فورتنايت|جيمنج|pubg|fifa|gta|valorant)/i.test(lower)) {
    return {
      domain: "gaming",
      categoryId: "20",
      audience: "اللاعبون وعشاق ألعاب الفيديو والبث المباشر",
      bestTime: "الخميس 9:00 مساءً بتوقيت القاهرة",
      coreTopicFallback: "جيم بلاي أسطوري وأقوى أسرار الاحتراف والتحديث الجديد",
      hashtags: ["ألعاب", "جيمنج", "Gaming", "جيم_بلاي", "بلايستيشن", "احتراف_الألعاب"],
      longTailTemplates: [
        `شرح التحديث الجديد واسرار الاحتراف ${YEAR}`,
        `افضل اعدادات اللعب ورفع الفريمات بدون لاج`,
        `تحديات وجيم بلاي اسطوري باعلى جودة`,
        `نصائح وخدع سرية للفوز في كل جيم بسهولة`,
        `{k} احترافي للمبتدئين`,
        `مراجعة شاملة لاقوى الالعاب الجديدة بالعربي`,
      ],
      playlist: "سلسلة الجيمنج والاحتراف",
      titleFormulas: [
        { angle: "تشويق الجيمنج", reason: "كلمات (أسطوري/مستحيل) ترفع نقر جمهور الألعاب", build: (t) => `${t} — جيم أسطوري لن تتوقع نهايته!` },
        { angle: "تصدر بحث الألعاب", reason: "يجمع اسم اللعبة وكلمة شرح", build: (t) => `شرح ${t} وأقوى أسرار الاحتراف` },
        { angle: "أعلى نسبة نقر", reason: "التحدي يخلق فضولاً قوياً", build: (t) => `تحدّي ${t} — هل أنجح فعلاً؟` },
        { angle: "قيمة عملية", reason: "الإعدادات مطلب بحثي دائم للاعبين", build: (t) => `أفضل إعدادات ${t} لرفع الأداء بدون لاج` },
        { angle: "تريند", reason: "يرتبط بالتحديثات الجديدة عالية البحث", build: (t) => `${t} بعد التحديث الجديد (${YEAR})` },
      ],
    };
  }

  if (/(طبخ|وصف|أكل|مطبخ|كيك|حلويات|غداء|عشاء|فطور|شيف|recipe|cook|food)/i.test(lower)) {
    return {
      domain: "cooking",
      categoryId: "26",
      audience: "عشاق الطبخ والوصفات البيتية السريعة والسهلة",
      bestTime: "الجمعة 4:00 عصراً بتوقيت القاهرة",
      coreTopicFallback: "أسهل وألذ وصفة منزلية بمكونات بسيطة وطعم احترافي",
      hashtags: ["طبخ", "وصفات_سهلة", "اكلات_سريعة", "مطبخ", "وصفات_منزلية", "أكل_بيتي"],
      longTailTemplates: [
        `طريقة عمل {k} سهلة وسريعة في البيت ${YEAR}`,
        `اكلات اقتصادية سريعة التحضير بمكونات في كل بيت`,
        `اسرار نجاح الوصفة من اول مرة مثل المطاعم`,
        `وصفات طبخ عربية سهلة ومجربة للمبتدئين`,
        `افضل طريقة تحضير {k} في 10 دقائق`,
      ],
      playlist: "وصفات سهلة وسريعة",
      titleFormulas: [
        { angle: "بحث عالي للوصفات", reason: "صيغة (طريقة عمل) هي الأعلى بحثاً في الطبخ", build: (t) => `طريقة عمل ${t} بأسهل الخطوات` },
        { angle: "أعلى نسبة نقر", reason: "الوعد بطعم المطاعم يرفع الفضول", build: (t) => `${t} بطعم المطاعم وبمكونات بسيطة من بيتك!` },
        { angle: "سرعة", reason: "تحديد الوقت يجذب المشاهدين المستعجلين", build: (t) => `${t} في 10 دقائق فقط — وصفة سريعة ولذيذة` },
        { angle: "اقتصادي", reason: "كلمة (اقتصادي) مطلوبة جداً عربياً", build: (t) => `${t} اقتصادية بمكونات متوفرة في كل بيت` },
        { angle: "دليل شامل", reason: "يشمل الأسرار والأخطاء", build: (t) => `${t}: الوصفة الكاملة مع أسرار النجاح` },
      ],
    };
  }

  if (/(ربح|مال|بيزنس|تجارة|استثمار|تسويق|فريلانس|عمل|فلوس|business|marketing|money|freelance|مشروع)/i.test(lower)) {
    return {
      domain: "business",
      categoryId: "27",
      audience: "رواد الأعمال والشباب الباحثون عن مصادر دخل وعمل عبر الإنترنت",
      bestTime: "الثلاثاء 8:00 مساءً بتوقيت القاهرة",
      coreTopicFallback: "خطة عملية لبناء مشروع ناجح والربح من الإنترنت",
      hashtags: ["الربح_من_الانترنت", "ريادة_الأعمال", "تجارة_الكترونية", "تسويق_رقمي", "العمل_الحر"],
      longTailTemplates: [
        `افضل طرق الربح من الانترنت للمبتدئين بدون راس مال ${YEAR}`,
        `كيف تبدأ مشروعك الاونلاين الناجح من الصفر`,
        `استراتيجيات التسويق الالكتروني لزيادة المبيعات بسرعة`,
        `العمل الحر على الانترنت وزيادة الدخل الشهري`,
        `{k} لتحقيق دخل اضافي حقيقي`,
        `خطوات عملية للنجاح المالي وبناء دخل سلبي مستمر`,
      ],
      playlist: "البيزنس والربح من الإنترنت",
      titleFormulas: [
        { angle: "بحث عالي", reason: "الربح بدون رأس مال هو البحث الأول عربياً", build: (t) => `${t} بدون رأس مال — خطة عملية (${YEAR})` },
        { angle: "أعلى نسبة نقر", reason: "الأرقام المالية المحددة ترفع النقر بقوة", build: (t) => `${t}: كيف تصل لأول دخل حقيقي هذا الشهر` },
        { angle: "مصداقية", reason: "تجربة شخصية حقيقية تبني الثقة والنقر", build: (t) => `جرّبت ${t} لمدة شهر — هذه هي النتيجة` },
        { angle: "دليل شامل", reason: "خطة كاملة من البداية للنهاية", build: (t) => `${t}: خطة العمل الكاملة خطوة بخطوة` },
        { angle: "فضول", reason: "الأخطاء تجذب من يخسر مالاً بالفعل", build: (t) => `أخطاء ${t} التي تخسرك المال دون أن تشعر` },
      ],
    };
  }

  if (/(رياضة|جيم|تمرين|لياقة|دايت|تخسيس|صحة|fitness|workout|gym|health|تغذية)/i.test(lower)) {
    return {
      domain: "fitness",
      categoryId: "17",
      audience: "المهتمون باللياقة البدنية والصحة وبناء الجسم",
      bestTime: "السبت 6:00 مساءً بتوقيت القاهرة",
      coreTopicFallback: "أفضل جدول تمارين ونصائح عملية لنتائج سريعة وصحية",
      hashtags: ["رياضة", "لياقة_بدنية", "تمارين", "صحة", "جيم", "تغذية_صحية"],
      longTailTemplates: [
        `افضل جدول تمارين في البيت للمبتدئين ${YEAR}`,
        `نصائح التغذية الصحية وحرق الدهون بسرعة`,
        `اخطاء شائعة في التمرين تمنع ظهور النتائج`,
        `تمارين يومية لشد الجسم وزيادة اللياقة البدنية`,
        `{k} بدون معدات في المنزل`,
      ],
      playlist: "اللياقة والصحة اليومية",
      titleFormulas: [
        { angle: "نتيجة سريعة", reason: "الجمهور يبحث عن نتائج بمدة محددة", build: (t) => `${t} — نتائج ملحوظة في أسبوعين` },
        { angle: "بحث عالي", reason: "صيغة (في البيت بدون معدات) مطلوبة جداً", build: (t) => `${t} في البيت بدون أي معدات` },
        { angle: "أعلى نسبة نقر", reason: "الوعد بخطأ شائع يثير الفضول", build: (t) => `لا تفعل هذا أثناء ${t} — خطأ شائع!` },
        { angle: "دليل شامل", reason: "جدول كامل قابل للتطبيق", build: (t) => `${t}: الجدول الكامل للمبتدئين` },
        { angle: "علمي", reason: "يستهدف الباحثين عن معلومات موثوقة", build: (t) => `${t} — الطريقة الصحيحة علمياً` },
      ],
    };
  }

  return {
    domain: "general",
    categoryId: "22",
    audience: "الجمهور العربي الباحث عن شروحات ومحتوى عالي القيمة",
    bestTime: "الخميس 7:30 مساءً بتوقيت القاهرة",
    coreTopicFallback: "دليل شامل خطوة بخطوة مع أهم الأسرار والنصائح",
    hashtags: ["شرح", "تعليم", "نصائح", "تريند", "محتوى_عربي", "يوتيوب"],
    longTailTemplates: [
      `افضل شرح كامل ومبسط عن {k} للمبتدئين ${YEAR}`,
      `خطوات عملية مضمونة للوصول لافضل نتيجة بسرعة`,
      `اهم النصائح والاسرار التي يجب ان تعرفها الان`,
      `دليل شامل عن {k} من الصفر حتى الاحتراف`,
      `اخطاء شائعة تجنبها عند {k}`,
      `{k} بطريقة سهلة ومختصرة`,
    ],
    playlist: "أهم الشروحات والأدلة الكاملة",
    titleFormulas: [
      { angle: "تصدر البحث الأول", reason: "الكلمة المفتاحية في أول العنوان + السنة", build: (t) => `${t} — الشرح الكامل (${YEAR})` },
      { angle: "أعلى نسبة نقر (CTR)", reason: "وعد واضح + نتيجة مضمونة يرفعان الضغط", build: (t) => `أقوى طريقة لـ ${t} | نتيجة مضمونة!` },
      { angle: "كلمة بحث طويلة", reason: "يطابق صيغة البحث الأكثر طلباً عربياً", build: (t) => `كيف تبدأ ${t} من الصفر حتى الاحتراف` },
      { angle: "فضول وتشويق", reason: "مثالي للظهور في الفيديوهات المقترحة", build: (t) => `أسرار ${t} التي يغفل عنها الجميع` },
      { angle: "مرجع شامل", reason: "قيمة فورية شاملة ترفع متوسط وقت المشاهدة", build: (t) => `كل ما تحتاج معرفته عن ${t} في فيديو واحد` },
    ],
  };
}

function cleanFileTopic(filename: string): string {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimAtWord(text: string, maxLen: number): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.55 ? sliced.slice(0, lastSpace) : sliced).trim();
}

/** Deterministic but realistic-looking search volume / competition metrics. */
function scoreKeyword(text: string, rng: () => number): {
  volume: KeywordTag["volume"];
  competition: KeywordTag["competition"];
  score: number;
} {
  const words = text.trim().split(/\s+/).length;
  const base = 80 + Math.floor(rng() * 14);
  const score = Math.min(98, base + Math.min(words, 5));
  const volume: KeywordTag["volume"] =
    score >= 92 ? "عالي جداً" : score >= 86 ? "عالي" : "متوسط";
  const competition: KeywordTag["competition"] =
    words >= 4 ? "منخفضة" : words === 3 ? (rng() > 0.5 ? "منخفضة" : "متوسطة") : "عالية";
  return { volume, competition, score };
}

function buildTags(
  focus: string,
  extraKeywords: string[],
  templates: string[],
  rng: () => number,
  isEnglish: boolean
): KeywordTag[] {
  const shortFocus = trimAtWord(focus, 46);
  const raw: string[] = [];

  if (isEnglish) {
    raw.push(
      `how to ${shortFocus} step by step ${YEAR}`,
      `${shortFocus} complete tutorial for beginners`,
      `best way to ${shortFocus} fast and free`,
      `${shortFocus} full guide explained ${YEAR}`,
      `${shortFocus} tips and mistakes to avoid`,
      ...extraKeywords.map((k) => `${shortFocus} ${k} guide`),
      shortFocus,
      `${shortFocus} ${YEAR}`
    );
  } else {
    for (const tpl of templates) {
      raw.push(tpl.replace(/\{k\}/g, shortFocus));
    }
    for (const k of extraKeywords.slice(0, 6)) {
      if (k && k !== shortFocus) raw.push(`${shortFocus} ${k}`);
    }
    raw.push(
      `شرح ${shortFocus} خطوة بخطوة للمبتدئين`,
      `افضل طريقة ${shortFocus} مجانا`,
      shortFocus,
      `${shortFocus} ${YEAR}`
    );
  }

  // De-duplicate, then fit into YouTube's 500-character tag budget
  const seen = new Set<string>();
  const tags: KeywordTag[] = [];
  let total = 0;

  for (const rawText of raw) {
    const text = rawText.replace(/\s+/g, " ").replace(/[<>]/g, "").trim();
    const key = text.toLowerCase();
    if (!text || text.length < 4 || seen.has(key)) continue;
    const addition = text.length + (tags.length ? 1 : 0);
    if (total + addition > 478) break;
    seen.add(key);
    total += addition;

    const words = text.split(/\s+/).length;
    const type: KeywordTag["type"] =
      words >= 3 ? "long_tail" : text.endsWith(String(YEAR)) ? "trending" : "core";
    const metrics = scoreKeyword(text, rng);
    tags.push({ text, type, ...metrics });
  }

  return tags;
}

function buildChapters(durationSeconds: number, topic: string, isEnglish: boolean, rng: () => number): VideoChapter[] {
  const dur = Math.max(60, durationSeconds || 480);
  const marks = [0, 0.1, 0.3, 0.52, 0.74, 0.9];
  const labels = isEnglish
    ? [
        `Intro & Why ${trimAtWord(topic, 30)} Matters`,
        "Essential Setup Before You Start",
        "Step-by-Step Practical Walkthrough",
        "Pro Tips & Common Mistakes",
        "Final Results & Live Check",
        "Summary & Next Steps",
      ]
    : [
        `المقدمة وأهمية ${trimAtWord(topic, 32)}`,
        "التجهيز والأساسيات قبل البدء",
        "الشرح العملي الكامل خطوة بخطوة",
        rng() > 0.5 ? "أسرار الاحتراف وتجنّب الأخطاء الشائعة" : "أهم الأخطاء التي يجب تجنبها",
        "استعراض النتيجة النهائية واختبار الأداء",
        "الخلاصة وأهم النصائح",
      ];

  return marks.map((ratio, idx) => ({
    time: formatDuration(Math.floor(dur * ratio)),
    label: labels[idx],
  }));
}

/* ------------------------------------------------------------------ */
/* Main analysis pipeline (no external API keys required)              */
/* ------------------------------------------------------------------ */

export function generateMoreLongTailTags(
  seedKeyword: string,
  existingTags: KeywordTag[],
  language = "ar"
): KeywordTag[] {
  const kw = seedKeyword.trim();
  if (!kw) return [];
  const isEn = language === "en" && !/[\u0600-\u06FF]/.test(kw);
  const existing = new Set(existingTags.map((t) => t.text.toLowerCase().trim()));
  const rng = makeRng(`${kw}-expand-${Date.now()}`);

  const pool: Array<{ text: string; type: KeywordTag["type"] }> = isEn
    ? [
        { text: `${kw} step by step tutorial ${YEAR}`, type: "long_tail" },
        { text: `how to master ${kw} for beginners`, type: "long_tail" },
        { text: `best free ${kw} setup guide`, type: "long_tail" },
        { text: `${kw} complete walkthrough no fluff`, type: "long_tail" },
        { text: `${kw} secret tips that actually work`, type: "trending" },
        { text: `${kw} mistakes you should avoid`, type: "long_tail" },
      ]
    : [
        { text: `طريقة ${kw} خطوة بخطوة للمبتدئين ${YEAR}`, type: "long_tail" },
        { text: `أفضل شرح عملي عن ${kw} مجانا`, type: "long_tail" },
        { text: `تعلّم ${kw} من الصفر حتى الاحتراف`, type: "long_tail" },
        { text: `حل مشاكل ${kw} وأهم النصائح الذهبية`, type: "long_tail" },
        { text: `تجربة حقيقية ومراجعة شاملة عن ${kw}`, type: "trending" },
        { text: `أخطاء يجب تجنبها عند ${kw}`, type: "long_tail" },
        { text: `${kw} بسهولة وفي أقل وقت ممكن`, type: "long_tail" },
      ];

  return pool
    .filter((item) => !existing.has(item.text.toLowerCase()))
    .map((item) => ({ text: item.text, type: item.type, ...scoreKeyword(item.text, rng) }));
}

export function analyzeVideoWithSmartEngine(input: AnalyzeVideoInput): AnalyzeVideoResult {
  const cleanedFile = cleanFileTopic(input.filename);
  const combinedText = [input.userPrompt, input.transcriptHint, cleanedFile]
    .filter(Boolean)
    .join(" . ");

  const seed = `${input.variationSeed || ""}|${input.filename}|${Date.now().toString(36)}`;
  const rng = makeRng(seed);
  const profile = detectDomain(combinedText);

  const extracted = extractKeywords(combinedText, 12);

  // 1. Topic: prefer the user's own description, then transcript keywords, then file name
  const promptFirstLine = input.userPrompt.trim().split(/[\n.!؟]/)[0].trim();
  const fileLooksGeneric =
    !cleanedFile ||
    cleanedFile.length < 4 ||
    /^(video|clip|record|rec|vid|img|mov|sample|test|untitled|new|screen|capture|\d+)$/i.test(cleanedFile);

  const detectedTopic =
    promptFirstLine.length >= 6
      ? trimAtWord(promptFirstLine, 72)
      : extracted.length >= 2 && input.transcriptHint.trim().length > 30
        ? trimAtWord(extracted.slice(0, 6).join(" "), 72)
        : !fileLooksGeneric
          ? trimAtWord(cleanedFile, 72)
          : profile.coreTopicFallback;

  const isEnglish = input.language === "en" && !/[\u0600-\u06FF]/.test(detectedTopic);
  const shortTopic = trimAtWord(detectedTopic, isEnglish ? 48 : 40);
  const focusKeyword = trimAtWord(detectedTopic.split(/\s+/).slice(0, 5).join(" "), 48);

  // 2. Titles: rotate the formula order per analysis so re-running gives fresh options
  const formulas = [...profile.titleFormulas];
  for (let i = formulas.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [formulas[i], formulas[j]] = [formulas[j], formulas[i]];
  }

  const candidates = formulas.map((f) => {
    const title = trimAtWord(f.build(shortTopic), 92);
    // Deterministic-ish quality metrics influenced by title shape
    const hasNumber = /[0-9٠-٩]/.test(title);
    const hasHook = /[!|؟?]/.test(title) || /(سر|أقوى|أسرار|لن|مجانا|مضمونة|أسطوري|secret|master|free)/i.test(title);
    const lenScore = title.length >= 35 && title.length <= 72 ? 6 : title.length >= 20 ? 3 : 0;
    const seoScore = Math.min(99, 84 + lenScore + (hasNumber ? 4 : 0) + Math.floor(rng() * 4));
    const ctrScore = Math.min(99, 85 + (hasHook ? 6 : 0) + (hasNumber ? 4 : 0) + Math.floor(rng() * 4));
    return { title, ctrScore, seoScore, angle: f.angle, reason: f.reason };
  });

  // Prefer the tone the user chose
  const tonePriority: Record<string, string[]> = {
    engaging: ["أعلى نسبة نقر", "أعلى نسبة نقر (CTR)", "فضول وتشويق", "تريند"],
    educational: ["دليل شامل", "شرح عملي", "تصدر البحث", "بحث عام عالي"],
    tech: ["تصدر البحث التقني", "شرح عملي", "قيمة عملية"],
    news: ["تريند", "تريند عالي البحث", "أعلى نسبة نقر"],
    entertainment: ["فضول", "تشويق", "أعلى نسبة نقر"],
  };
  const preferred = tonePriority[input.contentTone] || [];
  const rankOf = (c: TitleCandidate) => {
    const i = preferred.findIndex((p) => c.angle.includes(p));
    return i === -1 ? 99 : i;
  };
  candidates.sort((a, b) => {
    const d = rankOf(a) - rankOf(b);
    if (d !== 0) return d;
    return b.seoScore + b.ctrScore - (a.seoScore + a.ctrScore);
  });

  // Rotate inside the tone-matching group so re-running the analysis keeps
  // offering fresh angles instead of always returning the same title.
  const preferredCount = candidates.filter((c) => rankOf(c) < 99).length;
  if (preferredCount > 1) {
    const offset = Math.floor(rng() * preferredCount);
    const head = candidates.slice(0, preferredCount);
    candidates.splice(
      0,
      preferredCount,
      ...head.slice(offset),
      ...head.slice(0, offset)
    );
  }

  const chosenTitle = candidates[0].title;

  // 3. Chapters
  const chapters = buildChapters(input.durationSeconds, detectedTopic, isEnglish, rng);

  // 4. Hashtags (topic tag + domain tags + year)
  const topicTag = shortTopic
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("_");
  const hashtags = Array.from(
    new Set(
      [
        topicTag.length >= 3 ? `#${topicTag}` : "",
        ...profile.hashtags.map((h) => `#${h}`),
        `#تريند_${YEAR}`,
      ].filter(Boolean)
    )
  ).slice(0, 7);

  // 5. Long-tail tags built from real extracted keywords
  const extraKeywords = extracted.filter(
    (k) => !k.includes(" ") && k !== shortTopic && k.length >= 3
  );
  const tags = buildTags(
    focusKeyword,
    extraKeywords,
    isEnglish
      ? [`how to ${shortTopic} fast`, `${shortTopic} tips ${YEAR}`]
      : profile.longTailTemplates,
    rng,
    isEnglish
  );

  // 6. Description
  const chaptersText = chapters.map((c) => `${c.time} ${c.label}`).join("\n");
  const channelLine = input.channelTitle ? ` | قناة ${input.channelTitle}` : "";

  const description = isEnglish
    ? `In this complete ${YEAR} guide you will learn everything about ${detectedTopic} step by step, with practical tips you can apply right away.\n\nIf you are searching for a clean breakdown of ${focusKeyword}, this video walks you through the exact workflow from setup to real execution${channelLine}.\n\n⏱️ Video Chapters:\n${chaptersText}\n\n✅ What you will get from this video:\n• A clear step-by-step walkthrough of ${detectedTopic}\n• High-impact tips and the mistakes to avoid\n• A ready-to-apply setup and optimization workflow\n\n🔔 Subscribe and turn on notifications for weekly tutorials!\n💬 Got a question? Drop it in the comments and I will reply.\n\n${hashtags.slice(0, 5).join(" ")}`
    : `في هذا الفيديو الشامل (${YEAR}) نشرح لك بالتفصيل ${detectedTopic} خطوة بخطوة وبأسلوب عملي مبسّط يناسب المبتدئين والمحترفين${channelLine}.\n\nستتعلم معنا أهم الخطوات الصحيحة حول ${focusKeyword} لتصل إلى أفضل نتيجة بسرعة وبدون الأخطاء الشائعة، مع تطبيق عملي يمكنك تنفيذه فوراً${
        extracted.length > 2
          ? `، ونغطي داخل الشرح: ${extracted.slice(0, 5).join("، ")}.`
          : "."
      }\n\n⏱️ فصول الفيديو (التقسيم الزمني):\n${chaptersText}\n\n🎯 ماذا ستستفيد من هذا الفيديو؟\n• فهم عملي متكامل لموضوع ${detectedTopic}\n• أهم الخطوات الصحيحة المجربة والمضمونة\n• نصائح احترافية توفر عليك الوقت والجهد\n• تجنّب أشهر الأخطاء التي يقع فيها المبتدئون\n\n🔔 لا تنسَ الاشتراك في القناة وتفعيل زر الجرس ليصلك كل جديد أولاً بأول!\n👍 إذا أفادك الفيديو ادعمنا بلايك واكتب رأيك أو سؤالك في التعليقات وسأرد عليك فوراً.\n\n${hashtags.join(" ")}`;

  // 7. Captions (uses the real transcript when the user pasted one)
  const primaryLang = isEnglish ? "en" : "ar";
  const secondaryLang = isEnglish ? "ar" : "en";

  const primaryCaption = buildGeneratedCaptions({
    languageCode: primaryLang,
    topic: detectedTopic,
    title: chosenTitle,
    durationSeconds: input.durationSeconds,
    chapters,
    transcriptHint: primaryLang === "ar" ? input.transcriptHint : undefined,
  });

  const secondaryCaption = buildGeneratedCaptions({
    languageCode: secondaryLang,
    topic: detectedTopic,
    title: chosenTitle,
    durationSeconds: input.durationSeconds,
    chapters,
    transcriptHint: secondaryLang === "ar" ? input.transcriptHint : undefined,
  });

  const captions = [
    { languageCode: primaryLang, ...primaryCaption },
    { languageCode: secondaryLang, ...secondaryCaption },
  ];

  const suggestedCategoryId = input.categoryId || profile.categoryId;
  const suggestedLanguage = input.language || primaryLang;

  const breakdown = calculateSeoBreakdown({
    title: chosenTitle,
    description,
    hashtags,
    tags,
    captionsCount: captions.length,
    videoLanguage: suggestedLanguage,
    categoryId: suggestedCategoryId,
    focusKeyword,
  });

  return {
    aiProviderUsed: "tubesmart",
    detectedTopic,
    detectedAudience: profile.audience,
    bestPublishTime: profile.bestTime,
    focusKeyword,
    extractedKeywords: extracted.slice(0, 8),
    suggestedCategoryId,
    suggestedLanguage,
    title: chosenTitle,
    titleCandidates: candidates,
    description,
    chapters,
    hashtags,
    tags,
    seoScore: breakdown.total,
    captions,
  };
}
