---
title: Whatsapp Advisor
emoji: 💬
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
---
# WhatsApp AI Bot

This project is a smart WhatsApp assistant that can handle both casual conversations and more complex, knowledge-based queries. It acts as an intelligent routing system that decides when to use a fast, lightweight model for quick replies and when to escalate to a more powerful OpenAI Assistant backed by a custom knowledge base.

It also includes a human-in-the-loop system, allowing you to review and approve responses before anything is sent. This makes it useful for real-world group chats and semi-automated workflows.

---

## Features

* **Intelligent Routing System**
  Automatically classifies messages and routes them to either a lightweight model for fast responses or a specialized assistant for deeper queries.

* **Knowledge-Enhanced Responses**
  Integrates with the OpenAI Assistants API to provide answers grounded in external files and domain-specific context.

* **Human-in-the-Loop Control**
  Responses are reviewed through a local interface before being sent, giving you full control.

* **Context-Aware Conversations**
  Uses recent chat history to generate more relevant and natural responses.

* **Built for Real Usage**
  Designed to work in actual WhatsApp chats without spamming or over-automating.

---

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```env
OPENAI_API_KEY=your_openai_api_key_here
ASSISTANT_ID=your_openai_assistant_id_here
```

### 3. (Optional) Restrict to a Specific Group

In `index.js`, locate the config section and set `GROUP_ID` if you want the bot to run only in a specific WhatsApp group.

### 4. Run the Bot

```bash
node index.js
```

Scan the QR code using WhatsApp Linked Devices to authenticate.
Your session will be saved locally for future use.

---

## Usage

Trigger the bot by:

* Mentioning `@bot`
* Starting a message with `/reply`
* Saying `Pranav`

To review responses:

* Open `http://localhost:3000` (or your machine’s local IP with port 3000)
* Approve or edit messages before they are sent

---

## Why This Project

Most chatbots either respond to everything (which can get messy) or require constant manual input. This project balances both by combining automation with control.

It is designed to:

* Reduce unnecessary API usage through smart routing
* Improve response quality using context and knowledge bases
* Keep humans in control of final outputs

---

## Future Improvements

* Smarter routing using embeddings or classifiers
* Support for multiple assistants across domains
* Deployment beyond local hosting
* Basic analytics for usage and performance

---

