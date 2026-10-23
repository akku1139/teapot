export type ThemeMeta = {
  key: string;
  label: string;
  mode: "dark" | "light";
  /** three preview dots: page bg · raised surface · accent */
  sw: [string, string, string];
};

export const THEMES: ThemeMeta[] = [
  { key: "dark", label: "Dark", mode: "dark", sw: ["#1a1c22", "#2b2e39", "#5865f2"] },
  { key: "midnight", label: "Midnight", mode: "dark", sw: ["#0d0f18", "#252a42", "#8b7cf7"] },
  { key: "tea", label: "Milk Tea", mode: "dark", sw: ["#241c16", "#493b2d", "#d98e32"] },
  { key: "coffee", label: "Coffee", mode: "dark", sw: ["#191410", "#403527", "#c68a4b"] },
  { key: "matcha", label: "Matcha", mode: "dark", sw: ["#1b2217", "#3c4a33", "#8db64e"] },
  { key: "matrix", label: "Matrix", mode: "dark", sw: ["#060a06", "#18301d", "#2fd558"] },
  { key: "sunset", label: "Sunset", mode: "dark", sw: ["#1c1422", "#452f52", "#f2784b"] },
  { key: "light", label: "Light", mode: "light", sw: ["#eceef4", "#ffffff", "#4757d8"] },
  { key: "strawberry", label: "Strawberry", mode: "light", sw: ["#fbe4ea", "#fffafb", "#e05575"] },
  { key: "ramune", label: "Ramune", mode: "light", sw: ["#ddeff7", "#fbfeff", "#1d86ae"] },
];
