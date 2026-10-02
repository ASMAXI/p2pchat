const CHANNEL_W = "p2pchat-layout-channel-w";
const MEMBER_W = "p2pchat-layout-member-w";
const MEMBER_COLLAPSED = "p2pchat-layout-member-collapsed";

export function loadChannelPaneWidth(): number {
  const n = Number(window.localStorage.getItem(CHANNEL_W));
  return Number.isFinite(n) && n >= 200 && n <= 480 ? n : 272;
}

export function loadMemberPaneWidth(): number {
  const n = Number(window.localStorage.getItem(MEMBER_W));
  return Number.isFinite(n) && n >= 180 && n <= 420 ? n : 224;
}

export function saveChannelPaneWidth(px: number): void {
  window.localStorage.setItem(CHANNEL_W, String(Math.round(px)));
}

export function saveMemberPaneWidth(px: number): void {
  window.localStorage.setItem(MEMBER_W, String(Math.round(px)));
}

export function loadMemberPaneCollapsed(): boolean {
  return window.localStorage.getItem(MEMBER_COLLAPSED) === "1";
}

export function saveMemberPaneCollapsed(collapsed: boolean): void {
  window.localStorage.setItem(MEMBER_COLLAPSED, collapsed ? "1" : "0");
}
