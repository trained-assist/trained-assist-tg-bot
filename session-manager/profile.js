/**
 * Per-user profile stored in {workDir}/profile.json.
 * Fields: name, about, preferences, language.
 * Used to inject context into every Claude task.
 */

const fs = require('fs');
const path = require('path');

class ProfileManager {
  _path(user) { return path.join(user.workDir, 'profile.json'); }

  load(user) {
    try {
      return JSON.parse(fs.readFileSync(this._path(user), 'utf8'));
    } catch {
      return { name: user.name, about: '', preferences: '', language: 'ru' };
    }
  }

  save(user, profile) {
    fs.mkdirSync(user.workDir, { recursive: true });
    fs.writeFileSync(this._path(user), JSON.stringify(profile, null, 2));
  }

  toContext(profile, workDir = null) {
    const parts = [`Пользователь: ${profile.name}`];
    if (profile.about) parts.push(`О себе: ${profile.about}`);
    if (profile.preferences) parts.push(`Предпочтения: ${profile.preferences}`);
    if (profile.language) parts.push(`Язык общения: ${profile.language}`);
    if (workDir) {
      parts.push(
        `\n[Обогащение знаний]\n` +
        `Когда задача решена и пользователь упомянул новые требования к ассистенту — обнови ${workDir}/requirements.md (создай если нет).\n` +
        `Формат строк: "- [статус] Краткое требование — описание". Статусы: реализовано | в работе | планируется | отменено.\n` +
        `Если узнал новые факты о пользователе (профессия, привычки, контекст) — обнови ${workDir}/profile.json поле "about".\n` +
        `Делай это только когда задача уже решена, не посреди разговора.\n\n` +
        `[Уведомления о данных]\n` +
        `Если ты сохранил что-то чувствительное пользователя (токен, пароль, данные карты, ключ API) в Secret Manager или файл — сообщи об этом явно в конце ответа:\n` +
        `"🔒 Данные сохранены в защищённом хранилище. Я могу использовать их для задач, но не вижу значение напрямую и не смогу воспроизвести его в чате."\n` +
        `Если ты обработал файл с большим количеством личных данных (телефоны, email, имена) — в конце сообщи что файл будет удалён: "🗑 Файл с личными данными удалён с сервера после обработки."`
      );
    }
    return parts.length > 1 ? `[Профиль пользователя]\n${parts.join('\n')}` : null;
  }

  formatForDisplay(profile) {
    return [
      `👤 *${profile.name}*`,
      profile.about ? `О себе: ${profile.about}` : '_не заполнено_',
      profile.preferences ? `Предпочтения: ${profile.preferences}` : '',
      `Язык: ${profile.language || 'ru'}`,
    ].filter(Boolean).join('\n');
  }
}

module.exports = { ProfileManager };
