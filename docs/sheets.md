# Sheets used in this project

human readable and should stay very simple no agent changes although suggest if needed

## blocklist
- stores email domains and company names to not email because they wouldn't buy from jojospring or because they opted out, just read as whole list each time
- cols: company, email_domain

## search_log
- stores start and end not to search again because we're confident we got all contractors for these days for this state
- The 8 day ago half day wouldn't be the end date, but the 9 day ago full day that has already been called is the end date
- searched_at helps spread searching across different states
- cols: state, start, end (inclusive), searched_at

## leads
- stores leads that have been emailed
- storing zip code should help with attributing sales
- email_success: yes means email sent successfully, no means bounced, blank means haven't checked yet
- cols: contractor_id, emailed_at, name, thread_id, zip_code, email_success, email (in the future store the all emails instead of just primary email and LLM call picks the email most likely to be non generic and get a response)

## kill swtich sheet
- just one cell in A2 of yes/no
- A1: "Continue automatic outreach?"

## template sheet
- subject and body of email template to edit