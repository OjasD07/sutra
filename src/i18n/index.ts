/**
 * Interface strings. English is the default; Hindi is optional
 * (config `ui.language: "hi"`, or SUTRA_LANG=hi). Model output, tool names,
 * file paths and commands are never translated.
 */
const en = {
  tagline: "Intelligence, connected to action.",
  model: "Model",
  workspace: "Workspace",
  permission: "Permission",
  session: "Session",
  resumed: "resumed",
  prompt: "What would you like to build?",
  inputHint: "Enter to send · /help for commands · Ctrl+C to exit",
  runningHint: "Esc to cancel",
  thinking: "Thinking",
  reasoning: "Reasoning",
  working: "Working",
  awaitingApproval: "Awaiting approval",
  approveQuestion: "Apply this action?",
  approveYes: "yes",
  approveSession: "allow for this session",
  approveNo: "no",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused (budget)",
  filesChanged: "Files changed",
  tests: "Tests",
  estimatedCost: "Estimated cost",
  tokens: "Tokens",
  compacted: "Context compacted",
  noApiKey: "No DeepSeek API key found. Run `sutra init`, or set DEEPSEEK_API_KEY.",
  exitHint: "Press Ctrl+C again to exit",
  profileInspect: "Inspect",
  profileConfirm: "Confirm",
  profileFlow: "Flow",
} as const;

export type MessageKey = keyof typeof en;

const hi: Record<MessageKey, string> = {
  tagline: "बुद्धि, कर्म से जुड़ी।",
  model: "मॉडल",
  workspace: "कार्यक्षेत्र",
  permission: "अनुमति",
  session: "सत्र",
  resumed: "पुनः आरंभ",
  prompt: "आप क्या बनाना चाहेंगे?",
  inputHint: "भेजने के लिए Enter · आदेशों के लिए /help · बाहर निकलने के लिए Ctrl+C",
  runningHint: "रद्द करने के लिए Esc",
  thinking: "सोच रहा है",
  reasoning: "विचार कर रहा है",
  working: "काम जारी",
  awaitingApproval: "अनुमोदन की प्रतीक्षा",
  approveQuestion: "क्या यह क्रिया लागू करें?",
  approveYes: "हाँ",
  approveSession: "इस सत्र के लिए अनुमति",
  approveNo: "नहीं",
  complete: "पूर्ण",
  failed: "विफल",
  cancelled: "रद्द",
  paused: "रोका गया (बजट)",
  filesChanged: "बदली गई फ़ाइलें",
  tests: "परीक्षण",
  estimatedCost: "अनुमानित लागत",
  tokens: "टोकन",
  compacted: "संदर्भ संक्षिप्त किया गया",
  noApiKey: "DeepSeek API कुंजी नहीं मिली। `sutra init` चलाएँ, या DEEPSEEK_API_KEY सेट करें।",
  exitHint: "बाहर निकलने के लिए फिर से Ctrl+C दबाएँ",
  profileInspect: "निरीक्षण",
  profileConfirm: "पुष्टि",
  profileFlow: "प्रवाह",
};

export type Language = "en" | "hi";
let current: Language = "en";

export function setLanguage(lang: Language): void {
  current = lang;
}

export function t(key: MessageKey): string {
  return current === "hi" ? hi[key] : en[key];
}
