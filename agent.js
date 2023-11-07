import { initBot } from './utils/mcdata.js';
import { sendRequest } from './utils/gpt.js';
import { History } from './utils/history.js';
import { Coder } from './utils/coder.js';
import { getQuery, containsQuery, getQueryDocs } from './utils/queries.js';
import { getSkillDocs, containsCodeBlock } from './utils/skill_library.js';


export class Agent {
    constructor(name) {
        this.name = name;

        this.system_message = `You are a playful Minecraft bot named '${name}' that can communicate with players, see, move, mine, build, and interact with the world by writing and executing code.
        Act human-like as if you were a typical Minecraft player, rather than an AI. Be brief in your responses, omit needless words, and do not give instructions unless asked.`;
        this.system_message += getQueryDocs();
        this.system_message += getSkillDocs();

        this.bot = initBot(name);
        this.history = new History(this);
        this.coder = new Coder(this);

        this.bot.on('login', () => {
            this.bot.chat('Hello world! I am ' + this.name);
            console.log(`${this.name} logged in.`);
        });

        this.bot.on('chat', (username, message) => {
            if (username === this.name) return;
            console.log('received message from', username, ':', message);

            this.respond(username, message);
        });
    }

    async respond(username, message) {
        this.history.add(username, message);
        for (let i=0; i<5; i++) {
            let res = await sendRequest(this.history.getHistory(), this.system_message);
            this.history.add(this.name, res);
            let query_cmd = containsQuery(res);
            if (query_cmd) { // contains query
                let message = res.substring(0, res.indexOf(query_cmd)).trim();
                if (message) 
                    this.bot.chat(message);
                console.log('Agent used query:', query_cmd);
                let query = getQuery(query_cmd);
                let query_res = query.perform(this);
                this.history.add(this.name, query_res);
            }
            else if (containsCodeBlock(res)) { // contains code block
                let message = res.substring(0, res.indexOf('```')).trim();
                if (message) 
                    this.bot.chat(message);
                else
                    this.bot.chat("Executing code...");
                let code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
                if (code) {
                    console.log('Queuing code: ' + code);
                    this.coder.queueCode(code);
                }
                break;
            }
            else { // conversation response
                this.bot.chat(res);
                break;
            }
        }

        if (this.coder.hasCode()) {
            let code_return = await this.coder.execute();
            if (!code_return.success) {
                let message = "Code execution failed: " + code_return.message;
                this.history.add(this.name, message);
                let res = await sendRequest(this.history.getHistory(), this.system_message);
                this.history.add(this.name, res);
                this.bot.chat(res);
            }
        }
    }
}