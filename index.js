/**
 * Discord Role Bot – buttons + reaction roles (with single/multi select + target channel + sync)
 * Requires: Node 18+, discord.js ^14, dotenv
 * package.json should include:
 * {
 *   "type": "module",
 *   "scripts": { "start": "node index.js" }
 * }
 */

import 'dotenv/config';
import fs from 'node:fs';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionType,
  EmbedBuilder
} from 'discord.js';

// ---------- utils ----------
const wait = ms => new Promise(res => setTimeout(res, ms));

// ---------- persistence ----------
const DATA_FILE = './data.json';
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { guilds: {} }; }
}
function saveData(db) { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
const db = loadData();
function gstore(gid) {
  if (!db.guilds[gid]) db.guilds[gid] = { autorole: null, panels: {}, reactpanels: {} };
  return db.guilds[gid];
}

// ---------- client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel, Partials.Reaction]
});

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('role')
    .setDescription('Add or remove a role for a user')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub =>
      sub.setName('add').setDescription('Give a role to a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role to add').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove').setDescription('Remove a role from a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Configure auto role on member join')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub =>
      sub.setName('set').setDescription('Set the autorole')
        .addRoleOption(o => o.setName('role').setDescription('Role to auto-assign').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('clear').setDescription('Clear the autorole')),

  new SlashCommandBuilder()
    .setName('rr')
    .setDescription('Reaction-role utilities')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub =>
      sub.setName('create').setDescription('Create a role button panel')
        .addStringOption(o => o.setName('title').setDescription('Panel title').setRequired(true))
        .addRoleOption(o => o.setName('role1').setDescription('Role 1').setRequired(true))
        .addRoleOption(o => o.setName('role2').setDescription('Role 2'))
        .addRoleOption(o => o.setName('role3').setDescription('Role 3'))
        .addRoleOption(o => o.setName('role4').setDescription('Role 4'))
        .addRoleOption(o => o.setName('role5').setDescription('Role 5'))
        .addBooleanOption(o => o.setName('multi').setDescription('Allow selecting multiple roles from this panel?'))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to post the panel to'))
    )
    .addSubcommand(sub =>
      sub.setName('react').setDescription('Create an embed + emoji reaction roles (screenshot-style)')
        .addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true))
        .addStringOption(o => o.setName('image').setDescription('Image URL to show').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to send panel to'))
        .addBooleanOption(o => o.setName('multi').setDescription('Allow selecting multiple roles from this panel?'))
        .addStringOption(o => o.setName('emoji1').setDescription('Emoji for role1').setRequired(true))
        .addRoleOption(o => o.setName('role1').setDescription('Role 1').setRequired(true))
        .addStringOption(o => o.setName('emoji2').setDescription('Emoji for role2'))
        .addRoleOption(o => o.setName('role2').setDescription('Role 2'))
        .addStringOption(o => o.setName('emoji3').setDescription('Emoji for role3'))
        .addRoleOption(o => o.setName('role3').setDescription('Role 3'))
        .addStringOption(o => o.setName('emoji4').setDescription('Emoji for role4'))
        .addRoleOption(o => o.setName('role4').setDescription('Role 4'))
        .addStringOption(o => o.setName('emoji5').setDescription('Emoji for role5'))
        .addRoleOption(o => o.setName('role5').setDescription('Role 5'))
    )
    .addSubcommand(sub =>
      sub.setName('sync').setDescription('Re-scan all reaction panels in this server and fix roles now')
    )
].map(c => c.toJSON());

// ---------- register ----------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const app = await rest.get(Routes.currentApplication());
    const appId = app?.id;
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ---------- reaction sync core ----------
async function syncReactionPanel(guild, messageId, entry) {
  const channelId = entry.channelId;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return;

  const mapping = entry.mapping || entry;
  const exclusive = entry.exclusive ?? false;

  const roleIds = Object.values(mapping);
  const wantRoleUsers = new Map();
  roleIds.forEach(r => wantRoleUsers.set(r, new Set()));

  for (const [emojiStr, roleId] of Object.entries(mapping)) {
    const react = message.reactions.cache.find(r => r.emoji.toString() === emojiStr)
      || (await message.reactions.resolve(emojiStr));
    if (!react) continue;

    let after;
    while (true) {
      const users = await react.users.fetch({ limit: 100, after }).catch(() => null);
      if (!users || users.size === 0) break;
      for (const u of users.values()) if (!u.bot) wantRoleUsers.get(roleId)?.add(u.id);
      if (users.size < 100) break;
      after = users.last().id;
      await wait(300);
    }
    await wait(200);
  }

  const handled = new Set();
  for (const [roleId, userSet] of wantRoleUsers.entries()) {
    for (const userId of userSet) {
      if (handled.has(userId)) continue;
      handled.add(userId);
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;

      if (exclusive) {
        const keepRole = [...wantRoleUsers.entries()].find(([rid, set]) => set.has(userId))?.[0];
        const toRemove = roleIds.filter(rid => rid !== keepRole && member.roles.cache.has(rid));
        if (keepRole && !member.roles.cache.has(keepRole)) {
          await member.roles.add(keepRole, 'rr sync (exclusive)');
        }
        for (const rid of toRemove) {
          await member.roles.remove(rid, 'rr sync (exclusive cleanup)');
          await wait(120);
        }
      } else {
        for (const [rid, set] of wantRoleUsers.entries()) {
          if (set.has(userId) && !member.roles.cache.has(rid)) {
            await member.roles.add(rid, 'rr sync (multi)');
            await wait(120);
          }
        }
      }
      await wait(120);
    }
  }

  try {
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      const hasAny = roleIds.some(rid => member.roles.cache.has(rid));
      if (!hasAny) continue;
      const inAnySet = roleIds.some(rid => wantRoleUsers.get(rid)?.has(member.id));
      if (!inAnySet) {
        for (const rid of roleIds) {
          if (member.roles.cache.has(rid)) {
            await member.roles.remove(rid, 'rr sync (no longer reacting)');
            await wait(120);
          }
        }
      }
    }
  } catch {}
}

async function syncAllPanelsInGuild(guild) {
  const store = gstore(guild.id);
  const entries = store.reactpanels || {};
  for (const [messageId, entry] of Object.entries(entries)) {
    await syncReactionPanel(guild, messageId, entry).catch(() => {});
    await wait(400);
  }
}

// ---------- events ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try { await syncAllPanelsInGuild(guild); } catch {}
  }
});

// ---------- login ----------
(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();

