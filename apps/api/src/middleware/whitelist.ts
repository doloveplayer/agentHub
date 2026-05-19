import { config } from '../config.js';

export function isUserAllowed(githubLogin: string): boolean {
  return config.github.allowedUsers.includes(githubLogin);
}
