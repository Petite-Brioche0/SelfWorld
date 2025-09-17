import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds] 
});

client.once(Events.ClientReady, c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});


client.login(process.env.DISCORD_TOKEN);
