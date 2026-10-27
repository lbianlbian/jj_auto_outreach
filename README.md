# JJ auto outreach project
This is a repo housing the documentation, tests, and code for a project for CS 146S at Stanford. The project aims to automate lead sourcing and outreach and basic historical tracking for a small business. 

## Business context
See docs/proposal.md and docs/technical_spec.md note that infrastructure related content in there is now out of date

## More documentation
- docs/plan.md holds a human readable plan of what to do, and linear has the agent readable version. 
- docs/sheets.md holds simple detail on what sheets used in the project and their columns

## Ingestion
Using the shovels.ai API, the code here finds the emails of 10 electricians who recently filed an electric permit and have not already been found. Saved in leads sheet, make it its own subfolder next time

## Send email (coming soon)
New directory would handle this, Uses a template that can also be edited by a human. 

## Tracking (coming soon)
Code for tracking emails that have been sent and for updating emails as responded. Also planning some sort of kill switch for everything if someone responds or to pull at my discretion to update the system with new learnings. 

clasp which is google apps script's cli will be used for development

Switching infrastructure from original render.com plan to google apps script native:
- existence of clasp makes it possible to develop and deploy with agentic tools
- render.com cron jobs cost money
- GAS approach makes simplicity and usability by non technical business owner easier
- for course, practicing google apps script development with agentic tools when i previously never used agentic tools with GAS is good

#### Tasks/progress are tracked in Linear and Linear should be updated as things are done or new things to do are added. 