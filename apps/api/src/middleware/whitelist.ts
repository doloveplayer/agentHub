import { config } from '../config.js';

/** Check if user is the default admin */
export function isAdmin(username: string): boolean {
  return username === config.defaultAdmin.username;
}
