import { JSONFilePreset } from 'lowdb/node';

export interface UserProfile {
  name: string;
  wins: number;
  gamesPlayed: number;
}

export interface Database {
  users: UserProfile[];
  hallOfFame: UserProfile[];
}

const defaultData: Database = { users: [], hallOfFame: [] };

export async function getDb() {
  return await JSONFilePreset<Database>('db.json', defaultData);
}

export async function recordWin(name: string) {
  const db = await getDb();
  const user = db.data.users.find(u => u.name === name);

  if (user) {
    user.wins += 1;
    user.gamesPlayed += 1;
  } else {
    db.data.users.push({ name, wins: 1, gamesPlayed: 1 });
  }

  // Update Hall of Fame (Top 10 wins)
  db.data.hallOfFame = [...db.data.users]
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 10);

  await db.write();
}

export async function getLeaderboard() {
  const db = await getDb();
  return db.data.hallOfFame;
}
