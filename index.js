/**
 * Discord Role Bot – buttons + reaction roles (with single/multi select + target channel)
 * Requires: Node 18+, discord.js ^14, dotenv
 * package.json must include:  { "type": "module", "scripts": { "start": "node index.js" } }
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
        .addBooleanOption(o => o.setName('multi').setDescription('Allow selecting multiple roles from this panel?').setRequired(false))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to post the panel to').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('react').setDescription('Create an embed + emoji reaction roles (screenshot-style)')
        .addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true))
        .addStringOption(o => o.setName('image').setDescription('Image URL to show').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to send panel to').setRequired(false))
        .addBooleanOption(o => o.setName('multi').setDescription('Allow selecting multiple roles from this panel?').setRequired(false))
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
].map(c => c.toJSON());

// ---------- register ----------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = (await rest.get(Routes.oauth2CurrentApplication()))?.id;
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('Slash commands registered.');
}

// ---------- events ----------
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));

client.on('guildMemberAdd', async member => {
  const store = gstore(member.guild.id);
  const roleId = store.autorole;
  if (!roleId) return;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return;
  try { await member.roles.add(role, 'autorole'); } catch (e) { console.warn('Failed autorole:', e.message); }
});

// Reaction add/remove with partial safety + single-select enforcement
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

  const mapping = entry.mapping || entry; // backward compat
  const exclusive = entry.exclusive ?? false;

  const roleId = mapping[reaction.emoji.toString()];
  if (!roleId) return;

  const member = await guild.members.fetch(user.id);

  if (exclusive) {
    // remove all other roles in this panel
    const otherRoleIds = Object.values(mapping).filter(id => id !== roleId);
    for (const rid of otherRoleIds) {
      if (member.roles.cache.has(rid)) {
        await member.roles.remove(rid, 'exclusive reaction-role switch');
      }
    }
    // also clear user's other reactions on this message
    try {
      const userReactions = message.reactions.cache.filter(r => r.users.cache.has(user.id) && r.emoji.toString() !== reaction.emoji.toString());
      for (const r of userReactions.values()) await r.users.remove(user.id);
    } catch {}
  }

  await member.roles.add(roleId, 'reaction role');
});

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

  const mapping = entry.mapping || entry; // backward compat
  const roleId = mapping[reaction.emoji.toString()];
  if (!roleId) return;

  const member = await guild.members.fetch(user.id);
  // On remove, just remove role if they had it (works for both exclusive/multi)
  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId, 'reaction role remove');
  }
});

client.on('interactionCreate', async interaction => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;
  try {
    if (interaction.commandName === 'role') return handleRole(interaction);
    if (interaction.commandName === 'autorole') return handleAutorole(interaction);
    if (interaction.commandName === 'rr') return handleRR(interaction);
  } catch (e) { console.error(e); }
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
    store.reactpanels[msg.id] = { mapping, exclusive: !allowMulti };
    saveData(db);
  }
}

// Button handler with single-select support (for /rr create panels)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('rr:')) return;

  const roleId = interaction.customId.split(':')[1];
  const guild = interaction.guild;
  const store = gstore(guild.id);
  const entry = store.panels[interaction.message.id];

  // backward compat (old stored arrays)
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
      // remove all other roles in this panel first
      for (const rid of roles) {
        if (rid !== roleId && member.roles.cache.has(rid)) {
          await member.roles.remove(rid, 'exclusive button-role switch');
        }
      }
      if (!hasIt) await member.roles.add(role, 'exclusive button-role add');
      await interaction.reply({ content: `You now have ${role}.`, ephemeral: true });
    } else {
      // toggle
      if (hasIt) {
        await member.roles.remove(role, 'button role toggle');
        await interaction.reply({ content: `Removed ${role}.`, ephemeral: true });
      } else {
        await member.roles.add(role, 'button role toggle');
        await interaction.reply({ content: `Added ${role}.`, ephemeral: true });
      }
    }
  } catch (e) {
    await interaction.reply({ content: 'Failed. Check my role position and permissions.', ephemeral: true });
  }
});

// ---------- boot ----------
(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
