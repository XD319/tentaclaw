export type Locale = "en" | "zh-CN";

const copy = {
  en: {
    activity: "Activity", automation: "Automation", changes: "Changes", close: "Close", inbox: "Inbox",
    memory: "Memory", newChat: "New chat", running: "Running", searchSessions: "Search sessions",
    send: "Send", sessions: "Sessions", settings: "Settings", skills: "Skills", tasks: "Tasks",
    trace: "Trace", workspace: "Workspace", today: "Today", experience: "Experience", schedule: "Schedule",
    stop: "Stop", retry: "Retry", tools: "Tools", language: "Language", dismiss: "Dismiss",
    noTasks: "No tasks.", noSkills: "No skills.", noExperience: "No experience yet.",
    composer: "Message AutoTalon. Type / for commands.", commandHelp: "Command help"
  },
  "zh-CN": {
    activity: "活动", automation: "自动化", changes: "变更", close: "关闭", inbox: "收件箱",
    memory: "记忆", newChat: "新建会话", running: "运行中", searchSessions: "搜索会话",
    send: "发送", sessions: "会话", settings: "设置", skills: "技能", tasks: "任务",
    trace: "追踪", workspace: "工作区", today: "今日", experience: "经验", schedule: "计划",
    stop: "停止", retry: "重试", tools: "工具", language: "语言", dismiss: "关闭",
    noTasks: "暂无任务。", noSkills: "暂无技能。", noExperience: "暂无经验。",
    composer: "发送消息给 AutoTalon，输入 / 查看命令。", commandHelp: "命令帮助"
  }
} as const;

export type TranslationKey = keyof typeof copy.en;

export function initialLocale(): Locale {
  const saved = window.localStorage.getItem("auto-talon.locale");
  if (saved === "en" || saved === "zh-CN") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function translate(locale: Locale, key: TranslationKey): string {
  return copy[locale][key];
}
