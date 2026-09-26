export const FLAVORS = ["latte", "frappe", "macchiato", "mocha"] as const;
export const STYLES = ["canonical", "quiet", "mauve", "sapphire", "peach", "teal"] as const;

export type Flavor = (typeof FLAVORS)[number];
export type Style = (typeof STYLES)[number];

export const FLAVOR_LABELS: Record<Flavor, string> = {
  latte: "Latte",
  frappe: "Frappé",
  macchiato: "Macchiato",
  mocha: "Mocha",
};

export const STYLE_LABELS: Record<Style, string> = {
  canonical: "Canonical",
  quiet: "Quiet",
  mauve: "Mauve",
  sapphire: "Sapphire",
  peach: "Peach",
  teal: "Teal",
};

export const DEFAULT_FLAVOR: Flavor = "mocha";
export const DEFAULT_STYLE: Style = "mauve";

type Swatch =
  | "rosewater" | "flamingo" | "pink" | "mauve" | "red" | "maroon" | "peach" | "yellow"
  | "green" | "teal" | "sky" | "sapphire" | "blue" | "lavender"
  | "text" | "subtext1" | "subtext0" | "overlay2" | "overlay1" | "overlay0"
  | "surface2" | "surface1" | "surface0" | "base" | "mantle" | "crust";

type Palette = Record<Swatch, string>;

const PALETTES: Record<Flavor, Palette> = {
  latte: {
    rosewater: "#dc8a78", flamingo: "#dd7878", pink: "#ea76cb", mauve: "#8839ef",
    red: "#d20f39", maroon: "#e64553", peach: "#fe640b", yellow: "#df8e1d",
    green: "#40a02b", teal: "#179299", sky: "#04a5e5", sapphire: "#209fb5",
    blue: "#1e66f5", lavender: "#7287fd", text: "#4c4f69", subtext1: "#5c5f77",
    subtext0: "#6c6f85", overlay2: "#7c7f93", overlay1: "#8c8fa1", overlay0: "#9ca0b0",
    surface2: "#acb0be", surface1: "#bcc0cc", surface0: "#ccd0da",
    base: "#eff1f5", mantle: "#e6e9ef", crust: "#dce0e8",
  },
  frappe: {
    rosewater: "#f2d5cf", flamingo: "#eebebe", pink: "#f4b8e4", mauve: "#ca9ee6",
    red: "#e78284", maroon: "#ea999c", peach: "#ef9f76", yellow: "#e5c890",
    green: "#a6d189", teal: "#81c8be", sky: "#99d1db", sapphire: "#85c1dc",
    blue: "#8caaee", lavender: "#babbf1", text: "#c6d0f5", subtext1: "#b5bfe2",
    subtext0: "#a5adce", overlay2: "#949cbb", overlay1: "#838ba7", overlay0: "#737994",
    surface2: "#626880", surface1: "#51576d", surface0: "#414559",
    base: "#303446", mantle: "#292c3c", crust: "#232634",
  },
  macchiato: {
    rosewater: "#f4dbd6", flamingo: "#f0c6c6", pink: "#f5bde6", mauve: "#c6a0f6",
    red: "#ed8796", maroon: "#ee99a0", peach: "#f5a97f", yellow: "#eed49f",
    green: "#a6da95", teal: "#8bd5ca", sky: "#91d7e3", sapphire: "#7dc4e4",
    blue: "#8aadf4", lavender: "#b7bdf8", text: "#cad3f5", subtext1: "#b8c0e0",
    subtext0: "#a5adcb", overlay2: "#939ab7", overlay1: "#8087a2", overlay0: "#6e738d",
    surface2: "#5b6078", surface1: "#494d64", surface0: "#363a4f",
    base: "#24273a", mantle: "#1e2030", crust: "#181926",
  },
  mocha: {
    rosewater: "#f5e0dc", flamingo: "#f2cdcd", pink: "#f5c2e7", mauve: "#cba6f7",
    red: "#f38ba8", maroon: "#eba0ac", peach: "#fab387", yellow: "#f9e2af",
    green: "#a6e3a1", teal: "#94e2d5", sky: "#89dceb", sapphire: "#74c7ec",
    blue: "#89b4fa", lavender: "#b4befe", text: "#cdd6f4", subtext1: "#bac2de",
    subtext0: "#a6adc8", overlay2: "#9399b2", overlay1: "#7f849c", overlay0: "#6c7086",
    surface2: "#585b70", surface1: "#45475a", surface0: "#313244",
    base: "#1e1e2e", mantle: "#181825", crust: "#11111b",
  },
};

const STYLE_ROLES: Record<Style, { accent: Swatch; border: Swatch; heading: Swatch }> = {
  canonical: { accent: "lavender", border: "overlay0", heading: "text" },
  quiet: { accent: "subtext1", border: "surface2", heading: "subtext1" },
  mauve: { accent: "mauve", border: "overlay0", heading: "mauve" },
  sapphire: { accent: "sapphire", border: "overlay0", heading: "sapphire" },
  peach: { accent: "peach", border: "overlay0", heading: "peach" },
  teal: { accent: "teal", border: "overlay0", heading: "teal" },
};

export function catppuccinThemeName(flavor: Flavor, style: Style): string {
  return `catppuccin-${flavor}-${style}`;
}

export function parseFlavor(raw: string): Flavor | undefined {
  const value = raw.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return FLAVORS.find((flavor) => flavor === value);
}

export function parseStyle(raw: string): Style | undefined {
  const value = raw.trim().toLowerCase();
  return STYLES.find((style) => style === value);
}

export function parseCatppuccinTheme(name: string | undefined): { flavor: Flavor; style: Style } | undefined {
  if (!name) return undefined;
  const match = /^catppuccin-([a-z]+)-([a-z]+)$/.exec(name);
  if (!match) return undefined;
  const flavor = parseFlavor(match[1]);
  const style = parseStyle(match[2]);
  if (!flavor || !style) return undefined;
  return { flavor, style };
}

export function resolveCatppuccinTheme(
  name: string | undefined,
  flavor?: Flavor,
  style?: Style,
): { flavor: Flavor; style: Style; name: string } {
  const current = parseCatppuccinTheme(name);
  const nextFlavor = flavor ?? current?.flavor ?? DEFAULT_FLAVOR;
  const nextStyle = style ?? current?.style ?? DEFAULT_STYLE;
  return { flavor: nextFlavor, style: nextStyle, name: catppuccinThemeName(nextFlavor, nextStyle) };
}

export function themeMessage(flavor: Flavor, style: Style): string {
  return `Theme set to ${FLAVOR_LABELS[flavor]} · ${STYLE_LABELS[style]}`;
}

export type CatppuccinThemeJson = {
  $schema: string;
  name: string;
  vars: Record<string, string>;
  colors: Record<string, string>;
  export: { pageBg: string; cardBg: string; infoBg: string };
};

export function buildCatppuccinTheme(flavor: Flavor, style: Style): CatppuccinThemeJson {
  const palette = PALETTES[flavor];
  const roles = STYLE_ROLES[style];
  return {
    $schema: "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
    name: catppuccinThemeName(flavor, style),
    vars: {
      ...palette,
      accent: palette[roles.accent],
      border: palette[roles.border],
      heading: palette[roles.heading],
      panel: palette.mantle,
      surface: palette.surface0,
    },
    colors: {
      accent: "accent",
      border: "border",
      borderAccent: "accent",
      borderMuted: "surface1",
      success: "green",
      error: "red",
      warning: "yellow",
      muted: "subtext0",
      dim: "overlay1",
      text: "text",
      thinkingText: "overlay2",
      selectedBg: "surface1",
      scrollbarTrack: "surface0",
      scrollbarThumb: "overlay1",
      searchMatchBg: "teal",
      searchMatchText: "text",
      userMessageBg: "surface",
      userMessageText: "text",
      customMessageBg: "panel",
      customMessageText: "text",
      customMessageLabel: "accent",
      toolPendingBg: "surface",
      toolSuccessBg: "panel",
      toolErrorBg: "crust",
      toolTitle: "text",
      toolOutput: "subtext0",
      mdHeading: "heading",
      mdLink: "blue",
      mdLinkUrl: "overlay1",
      mdCode: "peach",
      mdCodeBlock: "text",
      mdCodeBlockBorder: "overlay0",
      mdQuote: "overlay2",
      mdQuoteBorder: "overlay0",
      mdHr: "overlay0",
      mdListBullet: "accent",
      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "overlay2",
      syntaxComment: "overlay2",
      syntaxKeyword: "mauve",
      syntaxFunction: "blue",
      syntaxVariable: "text",
      syntaxString: "green",
      syntaxNumber: "peach",
      syntaxType: "yellow",
      syntaxOperator: "sky",
      syntaxPunctuation: "overlay2",
      thinkingOff: "overlay0",
      thinkingMinimal: "overlay1",
      thinkingLow: "overlay2",
      thinkingMedium: "subtext0",
      thinkingHigh: "subtext1",
      thinkingXhigh: "lavender",
      thinkingMax: "mauve",
      bashMode: "green",
    },
    export: {
      pageBg: palette.base,
      cardBg: palette.mantle,
      infoBg: palette.crust,
    },
  };
}

export function allCatppuccinThemes(): CatppuccinThemeJson[] {
  return FLAVORS.flatMap((flavor) => STYLES.map((style) => buildCatppuccinTheme(flavor, style)));
}
