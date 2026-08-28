const USERS = [
  {
    id: 1714048,
    name: 'Vladimir',
    username: 'kobzevvv',
    workDir: '/home/vova/alesa-sessions/vladimir',
  },
  {
    id: 760768429,
    name: 'Mariam',
    username: 'proshaimamochka',
    workDir: '/home/vova/alesa-sessions/mariam',
  },
];

const BY_CHAT_ID = new Map(USERS.map(u => [u.id, u]));

function getUserByChatId(chatId) {
  return BY_CHAT_ID.get(chatId) ?? null;
}

module.exports = { getUserByChatId, USERS };
