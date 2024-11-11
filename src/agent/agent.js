import { History } from './history.js';
import { Coder } from './coder.js';
import { Prompter } from './prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import { isOtherAgent, initConversationManager, sendToBot, recieveFromBot } from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addViewer } from './viewer.js';
import settings from '../../settings.js';
import { loadTask } from '../utils/tasks.js';
import { TechTreeHarvestValidator } from '../../tasks/validation_functions/task_validator.js';
import {getPosition} from './library/world.js'
import { readFileSync } from 'fs';


export class Agent {
    async start(profile_fp, 
        load_mem=false, 
        init_message=null, 
        count_id=0, 
        task=null) {
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, profile_fp);
        this.name = this.prompter.getName();
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        initConversationManager(this);

        console.log('Task:', task);
        await this.prompter.initExamples();

        console.log('Logging in...');
        this.bot = initBot(this.name);

        if (task) {
            this.task = loadTask(task);
            if (this.task.type === 'harvest' || this.task.type === 'techtree') {
                this.validator = new TechTreeHarvestValidator(this.task, this.bot);
            }
            this.validator = new TechTreeHarvestValidator(this.task, this.bot);
            
        } else {
            this.task = null;
            this.validator = null;
        }

        // handle blocked actions
        if (this.task && "blocked_actions" in this.task) {
            if ("agent_number" in this.task && this.task.agent_number > 1) {
                this.blocked_actions = this.task.blocked_actions[this.name];
                console.log(`Blocked actions for ${this.name}:`, this.blocked_actions);
            } else {
                this.blocked_actions = this.task.blocked_actions;
                console.log(`Blocked actions:`, this.blocked_actions);
            }
        }
        
        console.log("Is validated:", this.validator && this.validator.validate());

        initModes(this);

        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }

        this.bot.once('spawn', async () => {
            addViewer(this.bot, count_id);

            // wait for a bit so stats are not undefined
            await new Promise((resolve) => setTimeout(resolve, 1000));

            console.log(`${this.name} spawned.`);
            this.clearBotLogs();

            this.bot.chat(`/clear ${this.name}`);
            console.log(`Cleared ${this.name}'s inventory.`);
            
            //wait for a bit so inventory is cleared
            await new Promise((resolve) => setTimeout(resolve, 500));

            //debug mode give one agent the target item 
            // if (this.name === 'andy') {
            //     this.bot.chat(`/give ${this.name} ${this.task.target} ${this.task.number_of_target}`);
            //     console.log(`/give ${this.name} ${this.task.target} ${this.task.number_of_target}`);
            // }
            
            
            console.log(this.task && "agent_number" in this.task && this.task.agent_number > 1);
            if (this.task && "agent_number" in this.task && this.task.agent_number > 1) {
                var initial_inventory = this.task.initial_inventory[this.name];
                console.log("Initial inventory:", initial_inventory);
            } else if (task) {
                console.log("Initial inventory:", this.task.initial_inventory);
                var initial_inventory = this.task.initial_inventory;
            }
            if (this.task && "initial_inventory" in this.task) {
                console.log("Setting inventory...");
                console.log("Inventory to set:", initial_inventory);
                for (let key of Object.keys(initial_inventory)) {
                    console.log('Giving item:', key);
                    this.bot.chat(`/give ${this.name} ${key} ${initial_inventory[key]}`);
                };
                //wait for a bit so inventory is set
                await new Promise((resolve) => setTimeout(resolve, 500));
                console.log("Done giving inventory items.");
            }

            if (this.task && "agent_number" in this.task && this.task.agent_number > 1) {
                var agent_names = this.task.agent_names;
                console.log("Agent names:", agent_names);
                for (let i=0; i<this.task.agent_number; i++) {
                    if (agent_names[i] !== this.name) {
                        console.log(`Teleporting ${this.name} to ${agent_names[i]}`);
                        this.bot.chat(`/tp ${this.name} ${agent_names[i]}`);
                    }
                }
            }
            // Function to generate random numbers

            function getRandomOffset(range) {
                return Math.floor(Math.random() * (range * 2 + 1)) - range;
            }

            let human_player_name = null;

            // Finding if there is a human player on the server
            for (const playerName in this.bot.players) {
                const player = this.bot.players[playerName];
                if (!isOtherAgent(player.username)) {
                    console.log('Found human player:', player.username);
                    human_player_name = player.username
                    break;
                }
                }

            // teleport near a human player if found by default

            if (this.task && "agent_number" in this.task) {
                var agent_names = this.task.agent_names;
                for (let i=0; i < this.task.agent_number; i++) {
                    if (human_player_name) {
                        console.log('Teleporting to human')
                        this.bot.chat(`/tp ${this.name} ${human_player_name}`) // teleport on top of the human player

                    }
                    else {
                        this.bot.chat(`/tp ${this.name} ${agent_names[i]}`) // teleport on top of other bots
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }

            // now all bots are teleport on top of each other
            // Now comes the teleportation to random distance from the human player part

            /*
            Note : We don't want randomness for construction task as the reference point matters a lot.
            Another reason for no randomness for construction task is because, often times the user would fly in the air,
            then set a random block to dirt and teleport the bot to stand on that block for starting the construction
            */

            if (this.task && this.task.type !== 'construction') {
                const pos = getPosition(this.bot);
                const xOffset = getRandomOffset(5);
                const zOffset = getRandomOffset(5);
                this.bot.chat(`/tp ${this.name} ${Math.floor(pos.x + xOffset)} ${pos.y + 3} ${Math.floor(pos.z + zOffset)}`);
            }
            
            const ignore_messages = [
                "Set own game mode to",
                "Set the time to",
                "Set the difficulty to",
                "Teleported ",
                "Set the weather to",
                "Gamerule "
            ];

            const respondFunc = async (username, message) => {
                if (username === this.name) return;
                
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (isOtherAgent(username)) {
                    recieveFromBot(username, message);
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            };

            this.bot.on('whisper', respondFunc);
            if (settings.profiles.length === 1)
                this.bot.on('chat', respondFunc);

            // set the bot to automatically eat food when hungry
            this.bot.autoEat.options = {
                priority: 'foodPoints',
                startAt: 14,
                bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
            };

            if (save_data && save_data.self_prompt) { // if we're loading memory and self-prompting was on, restart it, ignore init_message
                let prompt = save_data.self_prompt;
                // add initial message to history
                this.history.add('system', prompt);
                this.self_prompter.start(prompt);
            }
            else if (init_message) {
                this.handleMessage('system', init_message, 2);
            }
            else {
                const translation = await handleTranslation("Hello world! I am "+this.name);
                this.bot.chat(translation);
            }

            this.startEvents();
            
        });
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    async cleanChat(to_player, message, translate_up_to=-1) {
        if (isOtherAgent(to_player)) {
            this.bot.chat(message);
            sendToBot(to_player, message);
            return;
        }

        let to_translate = message;
        let remaining = '';
        if (translate_up_to != -1) {
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (to_player === 'system' || to_player === this.name) 
            this.bot.chat(message);
        else
            this.bot.whisper(to_player, message);
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.on) {
            this.self_prompter.stop(false);
        }
    }

    async handleMessage(source, message, max_responses=null) { 
        if (this.task && this.validator && this.validator.validate()) {
            this.killBots();
        }
        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1){
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.bot.chat(`Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.bot.chat(`*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.cleanChat(source, execute_res);
                return true;
            }
        }

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up;

        let behavior_log = this.bot.modes.flushBehaviorLog();
        if (behavior_log.trim().length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log.substring(behavior_log.indexOf('\n'));
            await this.history.add('system', behavior_log);
        }

        await this.history.add(source, message);
        this.history.save();


        if (!self_prompt && this.self_prompter.on) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {

            
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                console.log(`Full response: ""${res}""`)
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.verbose_commands) {
                    this.cleanChat(source, res, res.indexOf(command_name));
                }
                else { // only output command name
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.cleanChat(source, chat_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.cleanChat(source, res);
                console.log('Purely conversational response:', res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    

    async startEvents() {

        
        
        // Custom events
        // this.bot.on('spawn', () => {
            
        //     //check that inventory has been set
        // });


        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        this.bot.on('end', (reason) => {
            console.warn('Bot disconnected! Killing agent process.', reason)
            this.cleanKill('Bot disconnected! Killing agent process.');
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            console.warn('Bot kicked!', reason);
            this.cleanKill('Bot kicked! Killing agent process.');
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.x.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            if (this.task && this.validator && this.validator.validate()) {
                this.killBots();
            }
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            this.actions.resumeAction();
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    killBots() {
        console.log('Task completed!');
        this.bot.chat('Task completed!');
        this.bot.chat(`/clear @p`);

        // Kick other bots
        if (!this.task || !this.task.agent_number) {
            this.cleanKill('task completed', 0);
        }
        const agent_names = settings.profiles.map((p) => JSON.parse(readFileSync(p, 'utf8')).name); // Replace with the list of bot names
        const botNames = agent_names.filter(botName => botName !== this.name);
        console.log('Kicking bots:', botNames);
        botNames.forEach(botName => {
            this.bot.chat(`/kick ${botName}`);
            console.log(`/kick ${botName}`);

        });

        this.cleanKill('task completed', 0);
    }

    async update(delta) {
        await this.bot.modes.update();
        await this.self_prompter.update(delta);
    }

    isIdle() {
        return !this.actions.executing && !this.coder.generating;
    }
    
    cleanKill(msg='Killing agent process...', 
            code=1) {
        this.history.add('system', msg);
        this.bot.chat('Restarting.')
        this.history.save();
        process.exit(code);
    }

    // cleanKillForever(msg='Killing agent process...') {
    //     this.history.add('system', msg);
    //     this.bot.chat('Goodbye world.')
    //     this.history.save();
    //     process.exit(0);
    // }
}
