# Plan

This document is to stay human-written and a source for agents to connect to the linear mcp server to populate it with tasks. Coding agents are more than welcome to suggest tasks to add/modify/remove. When writing the tasks in Linear, provide:
- Title
- Description
- Status (e.g., To Do, In Progress, Done)
- Priority (e.g., High, Medium, Low)

## Done
- Project Proposal
- Technical Specs
- Exploration of and familiarization with shovels.ai
- research of using AI to write emails
- connect to linear
- set up clasp
- Refactor ingestion/ to use google apps script
- set up email sending functionality (includes making the email template)
- bad emails check: flag if email address was discovered to be bad after sending or if dns lookup on domain shows issues 
- set up kill switch, both on ingesting emails and sending them

## Next Up
- set up google apps script cron job
- set up tracking email replies
- set up html dashboard

## Potential future work
- automatically follow up on unanswered emails
- filter shovels.ai responses to verify electricians are actually electricians based on company name
- email open tracker
- dynamically improve email template based on previous responses and data with AI
- enable terminal runs of GAS by setting up google cloud project optional
- automatically stop outreach/add to blocklist when someone replies to opt out
- maybe observability on credits running out either with dashboard of remaining credits or automatic emails