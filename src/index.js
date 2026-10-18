const fs = require('fs');
const os = require('os');
const path = require('path');
const { isIP } = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const yts = require('yt-search');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config();

const encodedToken = 'TVRVMk1EazBOVGd6T1RNME1EVXhPVFV6TkEuR1FQUUh4LjRIM2ZtRTZFUlJTM1k0LVdQdEQwZ01mSXV6aDJhN0tHSzRHeWM0';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || Buffer.from(encodedToken, 'base64').toString('utf8');
const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 24) * 1024 * 1024;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const selections = new Map();
const mediaRequests = new Map();

function getFfmpegPath() {
  const binFfmpeg = path.join(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(binFfmpeg)) return binFfmpeg;
  if (ffmpegPath && fs.existsSync(ffmpegPath)) return ffmpegPath;
  return 'ffmpeg';
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const slashCommands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Musiqa qidirish va media havolalar uchun tugmali panel yuborish'),
  new SlashCommandBuilder()
    .setName('music')
    .setDescription('YouTube dan qo‘shiq izlab MP3 yoki video tanlang')
    .addStringOption((option) => option
      .setName('qidiruv')
      .setDescription('Qo‘shiq nomi yoki YouTube havolasi')
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('media')
    .setDescription('Rasm yoki ijtimoiy tarmoq videosini yuklab yuborish')
    .addStringOption((option) => option
      .setName('havola')
      .setDescription('YouTube, Instagram, TikTok yoki media URL')
      .setRequired(true)),
].map((command) => command.toJSON());

async function ensureDirectory(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function makeTempDir(prefix) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function validateHttpUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Havola noto‘g‘ri ko‘rinadi. To‘liq https:// URL yuboring.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Faqat http yoki https havolalar qo‘llab-quvvatlanadi.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = hostname.split('.').map(Number);
  const privateIpv4 = isIP(hostname) === 4 && (
    ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168)
  );
  const privateIpv6 = isIP(hostname) === 6
    && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd')
      || hostname.startsWith('fe80:') || hostname.startsWith('::ffff:'));
  if (parsed.username || parsed.password || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || privateIpv4 || privateIpv6) {
    throw new Error('Mahalliy yoki ichki tarmoq manzillarini ishlatib bo‘lmaydi.');
  }
  return parsed;
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function niceError(error) {
  if (error?.code === 'ENOTFOUND' || error?.cause?.code === 'ENOTFOUND') {
    return 'Internet/DNS orqali manzil topilmadi. Internet aloqasini tekshirib, qayta urinib ko‘ring.';
  }
  if (error?.name === 'AbortError') {
    return 'Xizmat javobi kechikdi. Birozdan so‘ng qayta urinib ko‘ring.';
  }
  return error?.message || 'Kutilmagan xatolik yuz berdi.';
}

async function ensureYtDlp() {
  const executable = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDlpPath = path.join(BIN_DIR, executable);
  if (fs.existsSync(ytDlpPath)) {
    if (process.platform !== 'win32') {
      await fs.promises.chmod(ytDlpPath, 0o755).catch(() => {});
    }
    return ytDlpPath;
  }

  await ensureDirectory(BIN_DIR);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${executable}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`yt-dlp yuklab olinmadi (${response.status}).`);
  }

  const temporaryPath = `${ytDlpPath}.tmp`;
  await fs.promises.writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  await fs.promises.rename(temporaryPath, ytDlpPath);
  if (process.platform !== 'win32') {
    await fs.promises.chmod(ytDlpPath, 0o755).catch(() => {});
  }
  return ytDlpPath;
}

async function findDownloadedFile(directory, extensions) {
  const files = await fs.promises.readdir(directory);
  const file = files.find((name) => extensions.includes(path.extname(name).toLowerCase()));
  return file ? path.join(directory, file) : null;
}

async function readLimitedResponse(response, description) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    throw new Error(`${description} Discord limitidan katta (${process.env.MAX_UPLOAD_MB || 24} MB).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${description} javobida fayl ma’lumoti yo‘q.`);
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`${description} Discord limitidan katta (${process.env.MAX_UPLOAD_MB || 24} MB).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadWithYtDlp(inputUrl, mode = 'video') {
  validateHttpUrl(inputUrl);
  const ytDlpPath = await ensureYtDlp();
  const workDir = await makeTempDir('discord-media-');
  const outputTemplate = path.join(workDir, '%(title).100s-%(id)s.%(ext)s');
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '--max-filesize', `${process.env.MAX_UPLOAD_MB || 24}M`,
    '--concurrent-fragments', '4',
    '--js-runtimes', 'node',
    '--output', outputTemplate,
  ];

  if (mode === 'audio') {
    args.push(
      '--format', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
    );
  } else {
    args.push(
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
    );
  }
  const ffmpeg = getFfmpegPath();
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  args.push(inputUrl);

  try {
    await execFileAsync(ytDlpPath, args, {
      cwd: workDir,
      timeout: 5 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const filePath = await findDownloadedFile(
      workDir,
      mode === 'audio' ? ['.mp3', '.m4a'] : ['.mp4', '.mkv', '.webm'],
    );
    if (!filePath) throw new Error('Yuklangan media fayl topilmadi.');
    return { filePath, workDir };
  } catch (error) {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    const details = error.stderr?.toString().trim();
    throw new Error(details ? `Yuklab olish xatosi: ${details.slice(-700)}` : niceError(error));
  }
}

function getDirectMediaType(input) {
  let pathname;
  try {
    pathname = new URL(input).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.(jpe?g|png|gif|webp|bmp|avif)$/.test(pathname)) return 'image';
  if (/\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/.test(pathname)) return 'video';
  return null;
}

async function downloadDirectMedia(input) {
  validateHttpUrl(input);
  const type = getDirectMediaType(input);
  if (!type) throw new Error('Rasm/video URL fayl kengaytmasi bilan tugashi kerak.');
  const workDir = await makeTempDir('discord-direct-media-');
  try {
    const response = await fetch(input, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Media URL xatosi: HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith(`${type}/`) && !contentType.includes('octet-stream')) {
      throw new Error('Havola rasm yoki video faylga olib bormadi.');
    }
    const bytes = await readLimitedResponse(response, type === 'image' ? 'Rasm' : 'Video');
    const extension = path.extname(new URL(response.url || input).pathname)
      || path.extname(new URL(input).pathname)
      || (type === 'image' ? '.jpg' : '.mp4');
    const filePath = path.join(workDir, `media${extension}`);
    await fs.promises.writeFile(filePath, bytes);
    return { filePath, workDir, type };
  } catch (error) {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadAudioWithCobalt(videoUrl) {
  validateHttpUrl(videoUrl);
  const apiUrl = process.env.COBALT_API_URL;
  if (!apiUrl) {
    throw new Error('COBALT_API_URL sozlanmagan. Faqat foydalanishga ruxsat berilgan Cobalt API manzilini kiriting.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-cobalt-client': 'discord-music-bot/1.0.0',
        ...(process.env.COBALT_API_KEY ? { Authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        url: videoUrl,
        downloadMode: 'audio',
        audioFormat: 'mp3',
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const detail = result?.error?.code || result?.error || `HTTP ${response.status}`;
    throw new Error(`Cobalt API xatosi: ${detail}. COBALT_API_URL sozlamasini tekshiring.`);
  }
  if (result.status === 'error' || !result.url) {
    throw new Error(`Cobalt MP3 tayyorlay olmadi: ${result.error?.code || result.text || 'API media URL qaytarmadi'}`);
  }

  const downloadUrl = validateHttpUrl(result.url);
  const workDir = await makeTempDir('discord-audio-');
  const filePath = path.join(workDir, `${Date.now()}.mp3`);
  try {
    const downloadResponse = await fetch(downloadUrl, { signal: AbortSignal.timeout(90_000) });
    if (!downloadResponse.ok) throw new Error(`MP3 fayl yuklanmadi (${downloadResponse.status}).`);
    const bytes = await readLimitedResponse(downloadResponse, 'MP3 fayl');
    await fs.promises.writeFile(filePath, bytes);
    return { filePath, workDir };
  } catch (error) {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

async function searchYoutube(query) {
  const results = await yts(query);
  if (!results?.videos?.length) throw new Error('YouTube qidiruvida natija topilmadi.');
  return results.videos.slice(0, 5);
}

function makeId() {
  return require('crypto').randomBytes(8).toString('hex');
}

function remember(store, value) {
  const id = makeId();
  store.set(id, { ...value, expiresAt: Date.now() + REQUEST_TTL_MS });
  setTimeout(() => store.delete(id), REQUEST_TTL_MS).unref();
  return id;
}

function makeMediaButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`download:audio:${id}`).setLabel('MP3 yuklab olish').setEmoji('🎵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`download:video:${id}`).setLabel('Video yuklab olish').setEmoji('🎬').setStyle(ButtonStyle.Secondary),
  );
}

function makeMediaActionRow(id, directType) {
  if (directType) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`download:media:${id}`)
        .setLabel(directType === 'image' ? 'Rasmni yuborish' : 'Videoni yuborish')
        .setEmoji('📥')
        .setStyle(ButtonStyle.Primary),
    );
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`download:video:${id}`)
      .setLabel('Videoni yuborish')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Primary),
  );
}

async function replySearchResults(interaction, query) {
  const videos = await searchYoutube(query);
  const id = remember(selections, {
    ownerId: interaction.user.id,
    videos,
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`select:${id}`)
    .setPlaceholder('Kerakli qo‘shiq yoki videoni tanlang')
    .addOptions(videos.map((video, index) => ({
      label: `${index + 1}. ${video.title}`.slice(0, 100),
      description: `${video.author?.name || 'YouTube'} • ${video.timestamp || 'davomiyligi noma’lum'}`.slice(0, 100),
      value: String(index),
    })));
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Qidiruv natijalari')
    .setDescription('Ro‘yxatdan kerakli videoni tanlang. Keyin MP3 yoki video tugmasini bosing.')
    .setFooter({ text: 'Tanlov 10 daqiqa davomida amal qiladi.' });
  await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}

async function sendSelectedMedia(interaction, media, mode) {
  if (media.ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Bu tugma boshqa foydalanuvchining so‘rovi uchun. O‘zingiz /music buyrug‘ini kiriting.', ephemeral: true });
    return;
  }
  if (media.expiresAt < Date.now()) {
    await interaction.reply({ content: 'Bu tanlovning muddati tugadi. Qayta /music ishlating.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  let download;
  try {
    if (mode === 'audio') {
      if (process.env.COBALT_API_URL) {
        try {
          download = await downloadAudioWithCobalt(media.url);
        } catch (cobaltError) {
          console.warn('Cobalt API xatosi, yt-dlp orqali yuklab olinmoqda:', cobaltError.message);
          download = await downloadWithYtDlp(media.url, 'audio');
        }
      } else {
        download = await downloadWithYtDlp(media.url, 'audio');
      }
    } else if (mode === 'media' && getDirectMediaType(media.url)) {
      download = await downloadDirectMedia(media.url);
    } else {
      download = await downloadWithYtDlp(media.url, 'video');
    }
    const stat = await fs.promises.stat(download.filePath);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(`Fayl Discord limitidan katta (${process.env.MAX_UPLOAD_MB || 24} MB).`);
    }
    const label = mode === 'audio' ? 'mp3' : download.type === 'image' ? 'rasm' : 'video';
    const fileName = `${label}-${path.basename(download.filePath)}`;
    await interaction.editReply({
      content: `✅ ${mode === 'audio' ? 'MP3' : download.type === 'image' ? 'Rasm' : 'Video'} tayyor: ${media.title}`,
      files: [new AttachmentBuilder(download.filePath, { name: fileName })],
      components: [],
    });
  } catch (error) {
    console.error('Media yuklab olish xatosi:', error);
    await interaction.editReply(`Xatolik: ${niceError(error)}`);
  } finally {
    if (download?.workDir) await fs.promises.rm(download.workDir, { recursive: true, force: true });
  }
}

function extractHttpUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>]+/i);
  return match ? match[0].replace(/[),.!?]+$/, '') : null;
}

function isSupportedLink(input) {
  let hostname;
  try {
    hostname = new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  return [
    'youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com',
    'x.com', 'twitter.com', 'facebook.com', 'fb.watch',
  ].some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

client.on('clientReady', async () => {
  console.log(`Discordga ulandi: ${client.user.tag}`);
  try {
    client.user.setPresence({
      status: 'online',
      activities: [{ name: '/panel | /music', type: ActivityType.Listening }],
    });
  } catch (presenceError) {
    console.warn('Statusni o‘rnatib bo‘lmadi:', presenceError);
  }
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    await rest.put(route, { body: slashCommands });
    console.log(process.env.GUILD_ID ? 'Server buyruqlari ro‘yxatdan o‘tdi.' : 'Global slash-buyruqlar ro‘yxatdan o‘tdi.');
  } catch (error) {
    console.error('Slash-buyruqlarni ro‘yxatdan o‘tkazib bo‘lmadi:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') {
        await interaction.deferReply();
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🎵 Musiqa va media')
          .setDescription('Qo‘shiqni tugma orqali qidiring yoki video havolasini yuborish uchun tugmani bosing.');
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('panel:search').setLabel('Qo‘shiq qidirish').setEmoji('🔎').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('panel:media').setLabel('Havola yuklash').setEmoji('📥').setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({ embeds: [embed], components: [buttons] });
        return;
      }
      if (interaction.commandName === 'music') {
        const query = interaction.options.getString('qidiruv', true);
        if (isUrl(query)) {
          const target = validateHttpUrl(query);
          const id = remember(mediaRequests, {
            ownerId: interaction.user.id,
            url: target.href,
            title: target.hostname,
          });
          const mediaType = getDirectMediaType(target.href);
          await interaction.reply({
            content: 'Havola qabul qilindi. Qaysi formatda olishni tanlang:',
            components: [mediaType ? makeMediaActionRow(id, mediaType) : makeMediaButtons(id)],
            ephemeral: true,
          });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        await replySearchResults(interaction, query);
        return;
      }
      if (interaction.commandName === 'media') {
        const input = interaction.options.getString('havola', true);
        if (!isSupportedLink(input) && !getDirectMediaType(input)) {
          throw new Error('YouTube, Instagram, TikTok, X/Facebook yoki to‘g‘ridan-to‘g‘ri rasm/video havolasini yuboring.');
        }
        const parsed = validateHttpUrl(input);
        const id = remember(mediaRequests, {
          ownerId: interaction.user.id,
          url: parsed.href,
          title: parsed.hostname,
        });
        await interaction.reply({
          content: 'Havola tayyor. Video sifatida yuborish uchun tugmani bosing:',
          components: [makeMediaActionRow(id, getDirectMediaType(parsed.href))],
          ephemeral: true,
        });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('panel:')) {
      const isSearch = interaction.customId === 'panel:search';
      const modal = new ModalBuilder()
        .setCustomId(isSearch ? 'panel-search-modal' : 'panel-media-modal')
        .setTitle(isSearch ? 'YouTube qidiruvi' : 'Media havola');
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(isSearch ? 'Qo‘shiq nomi yoki YouTube havolasi' : 'YouTube/Instagram/TikTok yoki media URL')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(isSearch ? 'Masalan: Ayni to play' : 'https://...')
        .setRequired(true)
        .setMaxLength(500);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit()) {
      const input = interaction.fields.getTextInputValue('value').trim();
      if (interaction.customId === 'panel-search-modal') {
        await interaction.deferReply({ ephemeral: true });
        if (isUrl(input)) {
          const target = validateHttpUrl(input);
          const id = remember(mediaRequests, {
            ownerId: interaction.user.id,
            url: target.href,
            title: target.hostname,
          });
          const type = getDirectMediaType(target.href);
          await interaction.editReply({
            content: 'Havola topildi. Kerakli tugmani bosing:',
            components: [type ? makeMediaActionRow(id, type) : makeMediaButtons(id)],
          });
        } else {
          await replySearchResults(interaction, input);
        }
        return;
      }
      if (interaction.customId === 'panel-media-modal') {
        if (!isSupportedLink(input) && !getDirectMediaType(input)) {
          throw new Error('YouTube, Instagram, TikTok, X/Facebook yoki to‘g‘ridan-to‘g‘ri rasm/video havolasini yuboring.');
        }
        const parsed = validateHttpUrl(input);
        const id = remember(mediaRequests, {
          ownerId: interaction.user.id,
          url: parsed.href,
          title: parsed.hostname,
        });
        await interaction.reply({
          content: 'Media havolasi tayyor. Yuklab olish uchun tugmani bosing:',
          components: [makeMediaActionRow(id, getDirectMediaType(parsed.href))],
          ephemeral: true,
        });
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const [, id] = interaction.customId.split(':');
      const selection = selections.get(id);
      if (!selection || selection.expiresAt < Date.now()) {
        await interaction.reply({ content: 'Tanlov muddati tugadi. Qayta /music ishlating.', ephemeral: true });
        return;
      }
      if (selection.ownerId !== interaction.user.id) {
        await interaction.reply({ content: 'Bu qidiruv natijalari boshqa foydalanuvchiga tegishli.', ephemeral: true });
        return;
      }
      const video = selection.videos[Number(interaction.values[0])];
      if (!video) throw new Error('Tanlangan natija topilmadi.');
      const idForDownload = remember(mediaRequests, {
        ownerId: interaction.user.id,
        url: video.url,
        title: video.title,
      });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(video.title.slice(0, 256))
        .setURL(video.url)
        .setDescription(`${video.author?.name || 'YouTube'} • ${video.timestamp || 'davomiyligi noma’lum'}`);
      if (video.thumbnail) embed.setThumbnail(video.thumbnail);
      await interaction.update({
        embeds: [embed],
        components: [makeMediaButtons(idForDownload)],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('download:')) {
      const [, mode, id] = interaction.customId.split(':');
      const media = mediaRequests.get(id);
      if (!media) {
        await interaction.reply({ content: 'So‘rov muddati tugadi. Qayta qidirib ko‘ring.', ephemeral: true });
        return;
      }
      await sendSelectedMedia(interaction, media, mode);
    }
  } catch (error) {
    if (error?.code === 10062) {
      console.warn('Discord interaction muddati o‘tib ketgan; foydalanuvchi buyruq yoki tugmani qayta yuborishi kerak.');
      return;
    }
    console.error('Discord interaction xatosi:', error);
    const content = `Xatolik: ${niceError(error)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, components: [] }).catch((replyError) => console.error('Xatolikni Discordga yuborib bo‘lmadi:', replyError));
    } else {
      await interaction.reply({ content, ephemeral: true }).catch((replyError) => console.error('Xatolikni Discordga yuborib bo‘lmadi:', replyError));
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const input = extractHttpUrl(message.content);
  if (!input || (!isSupportedLink(input) && !getDirectMediaType(input))) return;

  const id = remember(mediaRequests, {
    ownerId: message.author.id,
    url: input,
    title: new URL(input).hostname,
  });
  await message.reply({
    content: 'Havola aniqlandi. Media faylni olish uchun tugmani bosing:',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`download:${getDirectMediaType(input) ? 'media' : 'video'}:${id}`).setLabel('Media yuborish').setEmoji('📥').setStyle(ButtonStyle.Primary),
    )],
  }).catch((error) => console.error('Media tugmasini yuborib bo‘lmadi:', error));
});

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN topilmadi. .env faylini tekshiring.');
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch((error) => {
  console.error('Discord login xatosi:', error);
  process.exit(1);
});
