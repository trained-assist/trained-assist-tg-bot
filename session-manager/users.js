// Backwards-compat shim — real logic is in user-registry.js
const { getUserByChatId, LEGACY_USERS: USERS } = require('./user-registry');
module.exports = { getUserByChatId, USERS };
