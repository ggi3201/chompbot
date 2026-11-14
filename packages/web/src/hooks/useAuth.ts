import { useState, useEffect } from "react";
import { getToken, setToken, clearToken } from "../lib/api";

export function useAuth() {
  const [token, setTokenState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = getToken();
    setTokenState(stored);
    setIsLoading(false);
  }, []);

  function login(newToken: string) {
    setToken(newToken);
    setTokenState(newToken);
  }

  function logout() {
    clearToken();
    setTokenState(null);
  }

  return { token, isLoading, login, logout };
}
