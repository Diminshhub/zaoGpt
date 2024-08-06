import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from './commands/index.js';
// import { getSkillDocs } from './library/index.js';
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from './commands/index.js';

import { Gemini } from '../models/gemini.js';
import { GPT } from '../models/gpt.js';
import { Claude } from '../models/claude.js';
import { ReplicateAPI } from '../models/replicate.js';
import { Local } from '../models/local.js';


export class Prompter {
    constructor(agent, fp) {
        this.agent = agent;
        this.profile = JSON.parse(readFileSync(fp, 'utf8'));
        this.convo_examples = null;
        this.coding_examples = null;
        this.code_docs = null;

        let name = this.profile.name;
        let chat = this.profile.model;
        if (typeof chat === 'string' || chat instanceof String) {
            chat = {model: chat};
            if (chat.model.includes('gemini'))
                chat.api = 'google';
            else if (chat.model.includes('gpt'))
                chat.api = 'openai';
            else if (chat.model.includes('claude'))
                chat.api = 'anthropic';
            else if (chat.model.includes('meta/') || chat.model.includes('mistralai/') || chat.model.includes('replicate/'))
                chat.api = 'replicate';
            else
                chat.api = 'ollama';
        }

        console.log('Using chat settings:', chat);

        if (chat.api == 'google')
            this.chat_model = new Gemini(chat.model, chat.url);
        else if (chat.api == 'openai')
        {
            chat.url = this.profile.url; // Add this line to set the url for the GPT model
            this.chat_model = new GPT(chat.model, chat.url);
        }
        else if (chat.api == 'anthropic')
            this.chat_model = new Claude(chat.model, chat.url);
        else if (chat.api == 'replicate')
            this.chat_model = new ReplicateAPI(chat.model, chat.url);
        else if (chat.api == 'ollama')
            this.chat_model = new Local(chat.model, chat.url);
        else
            throw new Error('Unknown API:', api);

        let embedding = this.profile.embedding;
        if (embedding === undefined) {
            if (chat.api !== 'ollama')
                embedding = {api: chat.api};
            else
                embedding = {api: 'none'};
        }
        else if (typeof embedding === 'string' || embedding instanceof String)
            embedding = {api: embedding};

        console.log('Using embedding settings:', embedding);

        if (embedding.api == 'google')
            this.embedding_model = new Gemini(embedding.model, embedding.url);
        else if (embedding.api == 'openai') {
            embedding.url = this.profile.url; // Add this line to set the url for the GPT model
            this.embedding_model = new GPT(embedding.model, embedding.url);
        }
        else if (embedding.api == 'replicate') 
            this.embedding_model = new ReplicateAPI(embedding.model, embedding.url);
        else if (embedding.api == 'ollama')
            this.embedding_model = new Local(embedding.model, embedding.url);
        else {
            this.embedding_model = null;
            console.log('Unknown embedding: ', embedding ? embedding.api : '[NOT SPECIFIED]', '. Using word overlap.');
        }

        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw err;
            }
            console.log("Copy profile saved.");
        });
    }
    //Add a new asynchronous method to dynamically import getSkillDocs
    async loadSkillDocsFunc() {

        try {
            //1.Import the getSkillDocs function dynamically
            // Construct a path based on agent.name
            let moduleName = `../../bots/${this.agent.name}/library/index.js`;
            let skillModule = await import(moduleName);
            // get skillModule.getSkillDocs;
            const getSkillDocs = skillModule.getSkillDocs;
            return getSkillDocs;
        } catch (error) {
            console.error('Failed to load skill docs:', error);
            throw error;  // 抛出错误或处理错误
        }
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        // Using Promise.all to implement concurrent processing
        // This allows the conversation and coding examples to be loaded simultaneously
        function formatTime(date) {
            return date.toISOString().split('T')[1].split('.')[0];
        }

        const startTime = new Date();
        console.log(`Loading examples... ${formatTime(startTime)}`);

        // Create Examples instances
        this.convo_examples = new Examples(this.embedding_model);
        this.coding_examples = new Examples(this.embedding_model);
        this.code_docs = new Examples(this.embedding_model,5);
        this.loadSkillDocs = await this.loadSkillDocsFunc(); // Dynamically import getSkillDocs
        // Use Promise.all to load examples concurrently
        // console.log(`Loading conversation and coding examples...`);
        // console.log(await this.loadSkillDocs());
        await Promise.all([
            this.convo_examples.load(this.profile.conversation_examples),
            this.coding_examples.load(this.profile.coding_examples),
            this.code_docs.load(await this.loadSkillDocs())
        ]);
        // console.log('this.code_docs.embeddings:',this.code_docs.embeddings);
        const endTime = new Date();
        console.log(`Examples loaded. ${formatTime(endTime)}`);

        const loadTime = (endTime - startTime) / 1000;
        console.log(`Loading examples took ${loadTime} seconds.`);
    }

    async replaceStrings(prompt, messages, examples=null, prev_memory=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);
        // const loadSkillDocs = await this.loadSkillDocsFunc();
        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs());
        if (prompt.includes('$CODE_DOCS')) {
            console.log("====================================================================================================");
            let code_docs = await this.code_docs.getRelevantSkillDocs(messages);
            console.log(code_docs)
            prompt = prompt.replaceAll('$CODE_DOCS',code_docs);
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', prev_memory ? prev_memory : 'None.');
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        // console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        // console.log(prompt)
        return prompt;
    }

    async promptConvo(messages) {
        let prompt = this.profile.conversing;
        prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
        return await this.chat_model.sendRequest(messages, prompt);
    }

    async promptCoding(messages) {
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);
        return await this.chat_model.sendRequest(messages, prompt);
    }

    async promptMemSaving(prev_mem, to_summarize) {
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, prev_mem, to_summarize);
        return await this.chat_model.sendRequest([], prompt);
    }

    async promptGoalSetting(messages, last_goals) {
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }
}
