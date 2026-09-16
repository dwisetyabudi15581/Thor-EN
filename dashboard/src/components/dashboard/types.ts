// Shared types for the /api/me data used by dashboard components.
// v3 (free bot): no more premium/redemptions/keys — the dashboard is purely
// a server management tool ; the user identity is enough for
// login + guards.

export type UserInfo = {
  id: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  isAdmin: boolean;
};

export type MeConfig = {
  authReady: boolean;
  demoMode: boolean;
  inviteUrl: string;
  serverTime?: string;
  oauthRedirectUri?: string;
};

export type MeResponse = {
  user: UserInfo | null;
  config: MeConfig;
};
