# **CS146S Aut26 Technical Spec**

## **Problem Statement & Target User**

Niche online retailers (e.g., Jojospring) face declining platform search traffic (e.g., Wayfair, Overstock). Direct B2B outreach to high-volume buyers (e.g., contractors) offers a strong growth channel, but small teams lack bandwidth for manual lead research and tailored messaging.

## **System Solution**

An automated pipeline streamlining lead discovery, personalised message synthesis, and email engagement for scalable B2B sales.

## **Success Metrics**

- **Technical:** Delivery success rate, API reliability, workflow uptime.  
- **Business:** Response/conversion rates, new sales revenue.

# **Architecture**

## **Infrastructure & System Workflow**

1. **Ingestion:** Render cron queries [Shovels.ai](http://shovels.ai) API for contractor contacts and permits by location/type.  
2. **Synthesis:** LLM merges contractor context and product catalog to craft tailored pitches.  
3. **Dispatch:** Email service delivers proposals to target contractors.  
4. **Persistence:** Logs delivery, engagement, and statuses in Render PostgreSQL.  
5. **Dashboard:** Web UI displaying campaign performance analytics.

## **Architecture Diagram**

```mermaid
flowchart LR
    CRON["<b>Cron Job</b><br/><i>Main Orchestrator Script</i><br/><br/>Executes scheduled workflow sequentially:<br/>1. Queries API for data<br/>2. Passes prompt to LLM<br/>3. Sends formatted email<br/>4. Persists all step logs"]

    API["<b>STEP 1: DATA RETRIEVAL</b><br/>shovels.ai API<br/>Fetches permit & contractor info back to script"]
    LLM["<b>STEP 2: AI SYNTHESIS</b><br/>LLM<br/>Processes payload & returns generated email content"]
    EMAIL["<b>STEP 3: DISPATCH</b><br/>Email Client<br/>Receives generated email & sends to targets"]

    DB[("<b>Database</b><br/>Stores data & metadata collected from all execution steps")]
    DASH["<b>Dashboard</b><br/>Reads & visualizes persisted data from Database"]

    CRON <-->|"query / response"| API
    CRON <-->|"prompt / generated content"| LLM
    CRON -->|"formatted email"| EMAIL
    CRON -.->|"persist step logs"| DB
    DB --> DASH

    classDef orchestrator fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#fff
    classDef step1 fill:#1e293b,stroke:#2dd4bf,stroke-width:2px,color:#fff
    classDef step2 fill:#1e293b,stroke:#a855f7,stroke-width:2px,color:#fff
    classDef step3 fill:#1e293b,stroke:#ef4444,stroke-width:2px,color:#fff
    classDef storage fill:#1e293b,stroke:#f59e0b,stroke-width:2px,color:#fff

    class CRON orchestrator
    class API step1
    class LLM step2
    class EMAIL step3
    class DB,DASH storage
```

# **API Design**

## **Internal & External Endpoints**

- **Shovels.ai API:** Queries contractor profiles and permit data.  
- **GET /api/dashboard/stats:** Fetches DB metrics (leads, response rates, campaign stats) for frontend.

## **Database Schema Details**

Stores contractor metadata (ID, name, type, email) and outreach logs (sent timestamp, subject, body, status). Stretch: open tracking, thread ID, follow-up body text.

# **Technical Stack**

- **Language:** Python  
- **API Client:** requests library  
- **Data Source:** [Shovels.ai](http://shovels.ai) API  
- **LLM APIs:** Claude 3.5 Sonnet / OpenAI  
- **Hosting/DB:** [Render.com](http://render.com) (PostgreSQL & Cron)  
- **Frontend:** HTML, CSS, Vanilla JS

# **Agent Readiness**

- **Context & Documentation:** Repository includes a repository-level prompt (\`AGENTS.md\`) and file structure maps so AI agents can navigate the codebase autonomously.  
- **Tooling & Scripts:** Standardised CLI routines (\`make test\`, \`make lint\`, \`make dev\`) enable agents to run validations and spin up local environments cleanly.  
- **Modular Architecture:** Clear separation between data ingestion, synthesis, and dispatch components allows targeted agent code edits without unintended side effects.  
- **Integrations access:** [render.com](http://render.com) MCP server and [Shovels | Shovels CLI: Construction Data Straight From Your Terminal](https://www.shovels.ai/features/cli) agent-friendly interface for [shovels.ai](http://shovels.ai) help a coding agent properly understand and build the necessary infrastructure of the system. 