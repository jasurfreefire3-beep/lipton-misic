# Discord music and media bot

Discord bot with slash commands, search-result selection, and download buttons.

## Use

- `/panel` posts a reusable button panel. Press **Qo‘shiq qidirish** to open a search form or **Havola yuklash** to submit a media link.
- `/music qidiruv:<song or YouTube URL>` searches YouTube and offers a result picker. Choose a result, then press **MP3 yuklab olish** or **Video yuklab olish**.
- `/media havola:<YouTube, Instagram, TikTok, X, Facebook, or direct image/video URL>` presents a media download button.
- Posting a supported media link in a server channel automatically adds a **Media yuborish** button.

The bot downloads files only after a user presses a button. MP3 conversion uses a Cobalt API instance you are authorized to use; video downloads use yt-dlp. Files larger than the configured Discord upload limit are rejected with a clear message.

## Setup

1. Install packages: `npm install`
2. Copy `.env.example` to `.env`.
3. Set `DISCORD_TOKEN`.
4. Configure an authorized Cobalt API in `COBALT_API_URL`; add `COBALT_API_KEY` if that instance requires one.
5. Optionally set `GUILD_ID` to your test server ID. This registers commands to that server for faster testing; without it, commands are registered globally and may take time to appear.
6. In Discord Developer Portal, enable **Message Content Intent** if you want automatic link buttons when users post URLs.
7. Start the bot: `npm start`

The invite must include the `bot` and `applications.commands` scopes. The bot needs View Channels, Send Messages, Read Message History, Attach Files, and Embed Links.

## Cobalt API

Do not rely on `api.cobalt.tools` as a public API for third-party bots; hosted instances may block unauthorized clients. Use your own Cobalt instance or obtain access from an instance owner. See the [Cobalt API documentation](https://github.com/imputnet/cobalt/blob/main/docs/api.md).

## Safety

Keep `.env` private and never commit or share your Discord token or Cobalt API key.
