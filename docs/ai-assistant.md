# AI assistant (optional)

HomePanel can use an AI model in two places:

1. **Setup guide** in `homepanel setup --ai` (also offered when `homepanel setup` starts). You chat with it, and it explains each step, checks your network and HA, and runs
   setup steps for you, but only after you confirm each one (it shows exactly what will happen first).
2. **Admin assistant** in `/admin`. It helps you build widgets ("add a card with the CPU temp of the gaming PC"), register
   PCs, and add doorbells. Changes are shown first and only applied when you tap **Approve**.

Both are optional. The plain wizard and the admin UI do everything without AI, and if the AI fails mid-way
`homepanel setup` offers to continue with the plain wizard.

## Providers

All providers use the OpenAI-compatible chat API with **tool calling**, which the assistant needs.

| Provider | Cost | Key | Default model | Notes |
| --- | --- | --- | --- | --- |
| **Gemini** | free tier | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-3.8-flash` | Good quality. **On the free tier, Google uses your prompts to improve its products** (and humans may review them). Alternatives: `gemini-3.6-flash`, `gemini-3.5-flash-lite`. |
| **Groq** | free tier | [console.groq.com/keys](https://console.groq.com/keys) | `openai/gpt-oss-120b` | Very fast. Per-minute limits. If that model is unavailable, try `llama-3.3-70b-versatile`. |
| **OpenRouter** | free models | [openrouter.ai/keys](https://openrouter.ai/keys) | `openrouter/free` | Routes to a free model that supports tools. About 50 free requests/day without credits. Free models may log prompts. |
| **Ollama** | free, local | none | `qwen3:8b` | Runs on your own computer, and nothing leaves your network. |
| **LM Studio** | free, local | none | (model you load) | Same as Ollama, with a GUI. |
| **Custom** | — | maybe | — | Any OpenAI-compatible endpoint (base URL + model + key). |

**The catch with free cloud tiers:** you pay with data. Free tiers of Gemini, and many free OpenRouter models, may keep and
use what you send for training or review, and limits change without notice. The setup guide never sends secrets (see below),
but it does send your chat and setup progress. If that bothers you, run a local model.

**Model names change often.** If a default stops working, open the provider's model list and enter a current
tool-capable model name. Both the installer and the server let you override the model.

If a model doesn't support tool calling, the assistant tells you and continues as plain chat (it can explain, but
can't check or change anything). Pick a tool-capable model for hands-on help.

A free-tier limit shows as a "429 / rate limit" message. Wait a minute or switch to another provider. (The
`@homepanel/ai` library can also try several providers in order. Whether the server exposes that as a setting depends
on your server version.)

## Getting a key (Gemini example)

1. Go to aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key**, then copy it.
3. `homepanel setup` asks for it with a hidden prompt. In the HA app, paste it into the `ai_api_key` option. With Docker, put it in
   `AI_API_KEY` in `.env`.

## Running locally (private)

Ollama on the **gaming PC** is the best local option. The N100 mini PC is far too slow for an 8B model.

```powershell
# on the gaming PC
winget install Ollama.Ollama
ollama pull qwen3:8b
setx OLLAMA_HOST 0.0.0.0     # let other machines on the LAN use it; restart Ollama afterwards
```

Then choose **Ollama** with base URL `http://<gaming-pc-ip>:11434/v1`. Allow port 11434 through the Windows firewall
for your private network. With 8 GB of VRAM, qwen3:8b runs comfortably. Smaller models (4B and below) often get tool calls wrong.

LM Studio: load a tool-capable model, open the **Developer** tab, and start the server (port 1234). Turn on *Serve on Local Network*
if HomePanel runs on another machine.

## Privacy and safety

- **Secrets never go to the model (setup guide).** Passwords, tokens and API keys are typed into hidden local prompts. If the AI needs
  one, it calls `ask_secret`, and you type the value in the terminal. The AI only sees a placeholder such as `$SECRET_1`. Every message is
  also scanned, and any known secret is replaced before it is sent, including ones you paste into the chat by mistake.
- What the AI does see: your chat messages, your setup progress (host type, addresses, which steps are done), and
  the output of the steps it runs (for example "Mosquitto installed"). The admin assistant also sees entity names and states
  from Home Assistant.
- Every action that changes something (running a setup step, saving a profile, registering a PC, adding a doorbell)
  needs your explicit OK, and the exact change is shown first.
- If you want nothing to leave your network, use Ollama or LM Studio.
