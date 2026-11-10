// The rules of the game. Change these numbers to tune the economy.
export const RULES = {
  startBalance: 50, // characters every new account starts with
  deleteMultiplier: 2, // each deleted character costs this many
  approvedBonus: 0.5, // approved: full refund plus this share of the cost as a reward
  deniedRefund: 0.5, // denied, withdrawn or conflicted: this share of the cost comes back
  voteWindowHours: 24, // crowd mode: how long each edit is open for votes
  passShare: 0.51, // crowd mode: share of the weighted votes cast that must say yes
  maxCodeLength: 100_000, // the whole app's source may not grow past this many characters
};
