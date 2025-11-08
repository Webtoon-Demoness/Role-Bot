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
  const appId = (await rest.get(Routes.oauth2CurrentApplication()))?.id;
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('Slash commands registered.');
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
  const wantRoleUsers = new Map(); // roleId -> Set(userId)
  roleIds.forEach(r => wantRoleUsers.set(r, new Set()));

  // collect reactors
  for (const [emojiStr, roleId] of Object.entries(mapping)) {
    const react =
      message.reactions.cache.find(r => r.emoji.toString() === emojiStr) ||
      (await message.reactions.resolve(emojiStr));
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

  // enforce roles
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

  // optional cleanup: users with none of the reactions lose panel roles
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

client.on('guildMemberAdd', async member => {
  const store = gstore(member.guild.id);
  const roleId = store.autorole;
  if (!roleId) return;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return;
  try { await member.roles.add(role, 'autorole'); } catch (e) { console.warn('Failed autorole:', e.message); }
});

// reaction add
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch { return; }

  const message = reaction.message;
  const guild = message.guild;
  if (!guild) return;
  const store = gstore(guild.id);
  const entry = store.reactpanels[message.id];
  if (!entry) return;

  const mapping = entry.mapping || entry;
  const exclusive = entry.exclusive ?? false;

  const roleId = mapping[reaction.emoji.toString()];
  if (!roleId) return;

  const member = await guild.members.fetch(user.id);

  if (exclusive) {
    const otherRoleIds = Object.values(mapping).filter(id => id !== roleId);
    for (const rid of otherRoleIds) {
      if (member.roles.cache.has(rid)) await member.roles.remove(rid, 'exclusive reaction-role switch');
    }
    try {
      const userReactions = message.reactions.cache
        .filter(r => r.users.cache.has(user.id) && r.emoji.toString() !== reaction.emoji.toString());
      for (const r of userReactions.values()) await r.users.remove(user.id);
    } catch {}
  }

  await member.roles.add(roleId, 'reaction role');
});

// reaction remove
client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch { return; }

  const message = reaction.message;
  const guild = message.guild;
  if (!guild) return;
  const store = gstore(guild.id);
  const entry = store.reactpanels[message.id];
  if (!entry) return;

  const mapping = entry.mapping || entry;
  const roleId = mapping[reaction.emoji.toString()];
  if (!roleId) return;

  const member = await guild.members.fetch(user.id);
  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId, 'reaction role remove');
  }
});

// slash interactions
client.on('interactionCreate', async interaction => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;
  try {
    if (interaction.commandName === 'role') return handleRole(interaction);
    if (interaction.commandName === 'autorole') return handleAutorole(interaction);
    if (interaction.commandName === 'rr') return handleRR(interaction);
  } catch (e) { console.error(e); }
});

// button handler (for /rr create)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('rr:')) return;

  const roleId = interaction.customId.split(':')[1];
  const guild = interaction.guild;
  const store = gstore(guild.id);
  const entry = store.panels[interaction.message.id];

  let roles = [];
  let exclusive = false;
  if (Array.isArray(entry)) roles = entry;
  else if (entry && typeof entry === 'object') { roles = entry.roles || []; exclusive = !!entry.exclusive; }
  else return;

  if (!roles.includes(roleId)) return interaction.reply({ content: 'This button is stale.', ephemeral: true });

  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return interaction.reply({ content: 'Role missing now.', ephemeral: true });

  const member = await guild.members.fetch(interaction.user.id);
  const hasIt = member.roles.cache.has(roleId);

  try {
    if (exclusive) {
      for (const rid of roles) {
        if (rid !== roleId && member.roles.cache.has(rid)) {
          await member.roles.remove(rid, 'exclusive button-role switch');
        }
      }
      if (!hasIt) await member.roles.add(role, 'exclusive button-role add');
      await interaction.reply({ content: `You now have ${role}.`, ephemeral: true });
    } else {
      if (hasIt) {
        await member.roles.remove(role, 'button role toggle');
        await interaction.reply({ content: `Removed ${role}.`, ephemeral: true });
      } else {
        await member.roles.add(role, 'button role toggle');
        await interaction.reply({ content: `Added ${role}.`, ephemeral: true });
      }
    }
  } catch {
    await interaction.reply({ content: 'Failed. Check my role position and permissions.', ephemeral: true });
  }
});

// ---------- handlers ----------
async function handleRole(interaction) {
  const sub = interaction.options.getSubcommand();
  const member = await interaction.guild.members.fetch(interaction.options.getUser('user', true).id);
  const role = interaction.options.getRole('role', true);
  await interaction.deferReply({ ephemeral: true });
  if (sub === 'add') {
    await member.roles.add(role, `by ${interaction.user.tag}`);
    return interaction.editReply(`Added ${role} to ${member}.`);
  } else {
    await member.roles.remove(role, `by ${interaction.user.tag}`);
    return interaction.editReply(`Removed ${role} from ${member}.`);
  }
}

async function handleAutorole(interaction) {
  const sub = interaction.options.getSubcommand();
  const store = gstore(interaction.guild.id);
  if (sub === 'set') {
    const role = interaction.options.getRole('role', true);
    store.autorole = role.id;
    saveData(db);
    return interaction.reply({ content: `Autorole set to ${role}.`, ephemeral: true });
  } else {
    store.autorole = null;
    saveData(db);
    return interaction.reply({ content: 'Autorole cleared.', ephemeral: true });
  }
}

async function handleRR(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const title = interaction.options.getString('title', true);
    const allowMulti = interaction.options.getBoolean('multi') ?? true;
    const target = interaction.options.getChannel('channel') || interaction.channel;

    const roles = [];
    for (let i = 1; i <= 5; i++) {
      const r = interaction.options.getRole(`role${i}`, false);
      if (r) roles.push(r);
    }
    if (!roles.length) return interaction.reply({ content: 'Give me at least one role.', ephemeral: true });

    // perms check
    for (const r of roles) {
      const me = interaction.guild.members.me;
      if (!me || me.roles.highest.comparePositionTo(r) <= 0) {
        return interaction.reply({ content: `I can’t manage ${r}. Move my role above it.`, ephemeral: true });
      }
    }

    const row = new ActionRowBuilder().addComponents(
      ...roles.map(r => new ButtonBuilder().setCustomId(`rr:${r.id}`).setLabel(r.name).setStyle(ButtonStyle.Secondary))
    );

    const sent = await target.send({ content: `**${title}**\nClick to toggle roles:`, components: [row] });
    const store = gstore(interaction.guild.id);
    store.panels[sent.id] = { roles: roles.map(r => r.id), exclusive: !allowMulti };
    saveData(db);

    return interaction.reply({ content: `Panel posted in ${target}`, ephemeral: true });
  }

  if (sub === 'react') {
    const title = interaction.options.getString('title', true);
    const image = interaction.options.getString('image', true);
    const allowMulti = interaction.options.getBoolean('multi') ?? true;
    const target = interaction.options.getChannel('channel') || interaction.channel;

    const embed = new EmbedBuilder().setTitle(title).setImage(image).setColor('Blurple');

    const mapping = {};
    for (let i = 1; i <= 5; i++) {
      const emoji = interaction.options.getString(`emoji${i}`, false);
      const role = interaction.options.getRole(`role${i}`, false);
      if (emoji && role) mapping[emoji] = role.id;
    }
    if (!Object.keys(mapping).length) {
      return interaction.reply({ content: 'Give me at least one emoji + role pair.', ephemeral: true });
    }

    const desc = Object.entries(mapping).map(([e, id]) => `${e} <@&${id}>`).join('\n');
    embed.setDescription(desc);

    const msg = await target.send({ embeds: [embed] });
    await interaction.reply({ content: `Panel posted in ${target}`, ephemeral: true });

    for (const emoji of Object.keys(mapping)) { try { await msg.react(emoji); } catch {} }

    const store = gstore(interaction.guild.id);
    store.reactpanels[msg.id] = { mapping, exclusive: !allowMulti, channelId: target.id };
    saveData(db);
  }

  if (sub === 'sync') {
    await interaction.deferReply({ ephemeral: true });
    await syncAllPanelsInGuild(interaction.guild);
    return interaction.editReply('Sync complete.');
  }
}

// ---------- boot ----------
(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
