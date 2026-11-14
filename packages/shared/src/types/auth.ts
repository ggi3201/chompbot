export interface AuthSetupRequest {
  password: string;
}

export interface AuthLoginRequest {
  password: string;
}

export interface AuthResponse {
  token: string;
}

export interface AuthStatus {
  isSetup: boolean;
  authenticated: boolean;
}
