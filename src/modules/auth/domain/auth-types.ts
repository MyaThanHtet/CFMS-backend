export type AuthUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  googleSubject: string | null;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string;
};

export type IssuedSession = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: PublicUser;
};

export type GoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export type DeviceContext = {
  deviceId: string;
  deviceName: string | null;
};
