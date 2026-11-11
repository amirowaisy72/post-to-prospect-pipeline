// Realistic demo data so every page is usable on first open.
// Built by a function (not module-scope values) so nothing runs at import time.
import type { AppState, Person, Settings } from "./types";

const fb = (slug: string) => `https://facebook.com/${slug}`;
const p = (name: string, slug: string): Person => ({ name, url: fb(slug) });

export const DEFAULT_CRITERIA = {
  richBeginner:
    "Rich Beginner = new to investing (never invested, asking where to start) AND shows wealth (business owner, property, large savings, sold an asset).",
  richExperienced:
    "Rich Experienced = already investing (portfolio, years in the market, mutual funds, property units) AND shows wealth.",
  reject:
    "Reject = tip sellers, Telegram / WhatsApp promoters, group or course sellers, and spam profiles.",
};

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** Factory defaults for the Configurations page. */
export function createDefaultSettings(): Settings {
  return {
    provider: "ollama",
    model: "llama3.1:8b",
    ollamaUrl: DEFAULT_OLLAMA_URL,
    geminiApiKey: "",
    criteria: { ...DEFAULT_CRITERIA },
    leadRules: { defaultLeadsCount: 5, preferredMinAge: 35, gentleMinAge: 32 },
    sourcing: { minComments: 3, minMembers: 100 },
    database: { kind: "supabase", supabaseUrl: "", supabaseKey: "", connectionString: "" },
  };
}

export function createSeedState(): AppState {
  return {
    activeAccountId: "acc-1",
    defaultAccountId: "acc-1",
    accounts: [
      {
        id: "acc-1",
        name: "Ayesha — Main",
        facebookName: "Ayesha Khan",
        status: "active",
        createdAt: "2026-09-02T09:15:00.000Z",
      },
      {
        id: "acc-2",
        name: "Bilal — Research",
        facebookName: "Bilal Ahmed",
        status: "paused",
        createdAt: "2026-09-20T11:40:00.000Z",
      },
    ],
    sources: [
      {
        id: "src-1",
        name: "PSX Investors Pakistan",
        type: "group",
        url: "https://facebook.com/groups/psxinvestorspk",
        memberCount: 184_300,
        status: "joined",
        joinedByAccountId: "acc-1",
        lastScrapedAt: "2026-11-10T14:20:00.000Z",
      },
      {
        id: "src-2",
        name: "Karachi Business Owners Network",
        type: "group",
        url: "https://facebook.com/groups/karachibusinessowners",
        memberCount: 62_850,
        status: "joined",
        joinedByAccountId: "acc-1",
        lastScrapedAt: "2026-11-09T18:05:00.000Z",
      },
      {
        id: "src-3",
        name: "Dubai Property Investors Club",
        type: "group",
        url: "https://facebook.com/groups/dubaipropertyinvestorsclub",
        memberCount: 97_400,
        status: "joined",
        joinedByAccountId: "acc-2",
        lastScrapedAt: "2026-11-08T10:45:00.000Z",
      },
      {
        id: "src-4",
        name: "Smart Money Pakistan",
        type: "page",
        url: "https://facebook.com/smartmoneypakistan",
        memberCount: 241_000,
        status: "not-joined",
        joinedByAccountId: null,
        lastScrapedAt: null,
      },
      {
        id: "src-5",
        name: "Mutual Funds & Savings PK",
        type: "group",
        url: "https://facebook.com/groups/mutualfundssavingspk",
        memberCount: 38_120,
        status: "not-joined",
        joinedByAccountId: null,
        lastScrapedAt: null,
      },
    ],
    posts: [
      {
        id: "post-1",
        sourceId: "src-1",
        accountId: "acc-1",
        postUrl: "https://facebook.com/groups/psxinvestorspk/posts/7781203344",
        author: p("Usman Tariq", "usman.tariq.pk"),
        text: "Planning to put fresh money into PSX before the year ends. Which sectors are you all watching for 2027 — banks, cement or fertiliser? Share your thinking below.",
        collectedAt: "2026-11-10T14:20:00.000Z",
        comments: [
          {
            author: p("Sana Mirza", "sana.mirza.88"),
            text: "I just sold a plot in DHA and have around 2 crore sitting in my account. Completely new to stocks though — where do I even start?",
            replies: [
              {
                author: p("Usman Tariq", "usman.tariq.pk"),
                text: "Start with a broker account and blue chips, Sana.",
              },
              {
                author: p("Sana Mirza", "sana.mirza.88"),
                text: "Thanks! Is 2 crore too much to put in at once?",
              },
            ],
          },
          {
            author: p("Hamza Qureshi", "hamza.qureshi.lhr"),
            text: "Been investing in PSX for 6 years, my portfolio is mostly banks and OGDC. Recently exited a textile business so I have extra cash to diversify.",
            replies: [],
          },
          {
            author: p("Signals King PK", "signalskingpk"),
            text: "Join my Telegram channel for daily guaranteed signals 💯 t.me/signalsking",
            replies: [
              {
                author: p("Faraz Ali", "faraz.ali.khi"),
                text: "Reported. Stop spamming please.",
              },
            ],
          },
          {
            author: p("Nida Hassan", "nida.hassan.lhr"),
            text: "My husband and I run two pharmacies in Lahore. Never invested before but want our savings working. Is PSX safe for beginners?",
            replies: [
              {
                author: p("Kamran Shah", "kamran.shah.isb"),
                text: "I have held mutual funds and stocks for 10 years, PSX is fine if you stay diversified.",
              },
            ],
          },
          {
            author: p("Ali Raza", "ali.raza.2004"),
            text: "Where do I start? Just graduated, total beginner.",
            replies: [],
          },
        ],
      },
      {
        id: "post-2",
        sourceId: "src-2",
        accountId: "acc-1",
        postUrl: "https://facebook.com/groups/karachibusinessowners/posts/5520918873",
        author: p("Zainab Akhtar", "zainab.akhtar.khi"),
        text: "Business owners — where are you parking your extra cash these days? Bank deposits feel like they're losing to inflation.",
        collectedAt: "2026-11-09T18:05:00.000Z",
        comments: [
          {
            author: p("Omar Siddiqui", "omar.siddiqui.exports"),
            text: "We export garments and have a healthy cash reserve. I already invest in mutual funds and a few PSX stocks, looking to diversify into something new.",
            replies: [],
          },
          {
            author: p("Mehwish Iqbal", "mehwish.iqbal.salons"),
            text: "Own a chain of three salons in Clifton. Honestly I've never invested anything, it's all in savings accounts. Want to learn.",
            replies: [
              {
                author: p("Zainab Akhtar", "zainab.akhtar.khi"),
                text: "Same boat Mehwish!",
              },
              {
                author: p("Rizwan Malik", "rizwan.malik.trader"),
                text: "DM me for my investment course, 50% off this week only",
              },
            ],
          },
          {
            author: p("Tariq Jameel", "tariq.jameel.realty"),
            text: "Real estate is still king. I have rental income from 4 apartments and I've been investing in property for 15 years.",
            replies: [],
          },
          {
            author: p("Hira Baig", "hira.baig.92"),
            text: "Interesting thread. Following.",
            replies: [],
          },
        ],
      },
      {
        id: "post-3",
        sourceId: "src-3",
        accountId: "acc-2",
        postUrl: "https://facebook.com/groups/dubaipropertyinvestorsclub/posts/9902117765",
        author: p("Faisal Nadeem", "faisal.nadeem.dxb"),
        text: "Off-plan vs ready property in Dubai Marina — what's giving better returns in 2026?",
        collectedAt: "2026-11-08T10:45:00.000Z",
        comments: [
          {
            author: p("Ahmed Khalid", "ahmed.khalid.uae"),
            text: "First time buyer here. Sold my family business last year and want to put money into a villa. No idea how off-plan works.",
            replies: [
              {
                author: p("Faisal Nadeem", "faisal.nadeem.dxb"),
                text: "Ahmed, happy to share what worked for me.",
              },
            ],
          },
          {
            author: p("Rabia Anwar", "rabia.anwar.invest"),
            text: "I've held three off-plan units since 2019 and already flipped two. Looking for my next project around 3M AED.",
            replies: [],
          },
          {
            author: p("Bilal Promotions", "bilal.promotions.official"),
            text: "Free WhatsApp group for property tips, join now!!!",
            replies: [],
          },
          {
            author: p("Saad Hussain", "saad.hussain.dxb"),
            text: "Is it worth it for someone on a regular salary just starting out?",
            replies: [],
          },
        ],
      },
    ],
    leads: [
      {
        id: "lead-1",
        name: "Sana Mirza",
        profileUrl: fb("sana.mirza.88"),
        priority: "rich-beginner",
        reason:
          "New to investing (“new to stocks”, “where do I even start”) and shows wealth (“sold a plot”, “2 crore”).",
        quotedComment:
          "I just sold a plot in DHA and have around 2 crore sitting in my account. Completely new to stocks though — where do I even start?",
        sourcePostId: "post-1",
        accountId: "acc-1",
        status: "shortlisted",
      },
      {
        id: "lead-2",
        name: "Hamza Qureshi",
        profileUrl: fb("hamza.qureshi.lhr"),
        priority: "rich-experienced",
        reason:
          "Already investing (“been investing”, “portfolio”, “6 years”) and shows wealth (“textile business”, “extra cash”).",
        quotedComment:
          "Been investing in PSX for 6 years, my portfolio is mostly banks and OGDC. Recently exited a textile business so I have extra cash to diversify.",
        sourcePostId: "post-1",
        accountId: "acc-1",
        status: "new",
      },
      {
        id: "lead-3",
        name: "Ali Raza",
        profileUrl: fb("ali.raza.2004"),
        priority: "other",
        reason: "Shows interest in investing (“total beginner”) but no clear sign of wealth.",
        quotedComment: "Where do I start? Just graduated, total beginner.",
        sourcePostId: "post-1",
        accountId: "acc-1",
        status: "rejected",
      },
      {
        id: "lead-4",
        name: "Omar Siddiqui",
        profileUrl: fb("omar.siddiqui.exports"),
        priority: "rich-experienced",
        reason:
          "Already investing (“already invest”, “mutual funds”) and shows wealth (“export”, “cash reserve”).",
        quotedComment:
          "We export garments and have a healthy cash reserve. I already invest in mutual funds and a few PSX stocks, looking to diversify into something new.",
        sourcePostId: "post-2",
        accountId: "acc-1",
        status: "shortlisted",
      },
      {
        id: "lead-5",
        name: "Mehwish Iqbal",
        profileUrl: fb("mehwish.iqbal.salons"),
        priority: "rich-beginner",
        reason:
          "New to investing (“never invested”, “want to learn”) and shows wealth (“chain of three salons”, “savings”).",
        quotedComment:
          "Own a chain of three salons in Clifton. Honestly I've never invested anything, it's all in savings accounts. Want to learn.",
        sourcePostId: "post-2",
        accountId: "acc-1",
        status: "new",
      },
      {
        id: "lead-6",
        name: "Ahmed Khalid",
        profileUrl: fb("ahmed.khalid.uae"),
        priority: "rich-beginner",
        reason:
          "New to investing (“first time”, “no idea”) and shows wealth (“sold my family business”, “villa”).",
        quotedComment:
          "First time buyer here. Sold my family business last year and want to put money into a villa. No idea how off-plan works.",
        sourcePostId: "post-3",
        accountId: "acc-2",
        status: "new",
      },
      {
        id: "lead-7",
        name: "Rabia Anwar",
        profileUrl: fb("rabia.anwar.invest"),
        priority: "rich-experienced",
        reason:
          "Already investing (“held three off-plan units”, “already flipped”) and shows wealth (“3M AED”).",
        quotedComment:
          "I've held three off-plan units since 2019 and already flipped two. Looking for my next project around 3M AED.",
        sourcePostId: "post-3",
        accountId: "acc-2",
        status: "shortlisted",
      },
      {
        id: "lead-8",
        name: "Saad Hussain",
        profileUrl: fb("saad.hussain.dxb"),
        priority: "other",
        reason: "Shows interest in investing (“just starting”) but no clear sign of wealth.",
        quotedComment: "Is it worth it for someone on a regular salary just starting out?",
        sourcePostId: "post-3",
        accountId: "acc-2",
        status: "new",
      },
    ],
    activity: [
      {
        id: "act-7",
        type: "lead-shortlisted",
        accountId: "acc-1",
        message: "Shortlisted Sana Mirza",
        at: "2026-11-10T15:02:00.000Z",
      },
      {
        id: "act-6",
        type: "analysis-finished",
        accountId: "acc-1",
        message: "Analysis finished on 2 posts — 5 leads found",
        at: "2026-11-10T14:40:00.000Z",
      },
      {
        id: "act-5",
        type: "post-collected",
        accountId: "acc-1",
        message: "Collected a post from PSX Investors Pakistan",
        at: "2026-11-10T14:20:00.000Z",
      },
      {
        id: "act-4",
        type: "post-collected",
        accountId: "acc-1",
        message: "Collected a post from Karachi Business Owners Network",
        at: "2026-11-09T18:05:00.000Z",
      },
      {
        id: "act-3",
        type: "analysis-finished",
        accountId: "acc-2",
        message: "Analysis finished on 1 post — 3 leads found",
        at: "2026-11-08T11:10:00.000Z",
      },
      {
        id: "act-2",
        type: "source-joined",
        accountId: "acc-2",
        message: "Joined Dubai Property Investors Club",
        at: "2026-11-01T08:30:00.000Z",
      },
      {
        id: "act-1",
        type: "source-joined",
        accountId: "acc-1",
        message: "Joined PSX Investors Pakistan",
        at: "2026-10-28T12:00:00.000Z",
      },
    ],
    settings: createDefaultSettings(),
  };
}
