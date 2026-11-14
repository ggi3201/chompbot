const CONTENT = `# Apple Shortcuts

Shortcuts are how you reach other apps on the user's iPhone. iOS does not let Chomp read another app's screen or data, or tap inside it. A Shortcut can use the actions those apps offer.

## Run one

- \`phone_call_tool\` with \`name: "run_shortcut"\` and \`args: {name, input?}\` runs it and returns \`output\`, its text output. Only text comes back, and it gives up after 2 minutes. The phone goes back to Chomp when it ends.
- \`phone_call_tool\` with \`name: "open_url"\` and \`args: {url}\` opens a website or a deep link into an app.

**Both need Chomp on screen**, because iOS only lets the app in front open another app. If you get that error, ask the user to open Chomp and then try again. Do not retry until they say so. You cannot list the Shortcuts on the phone, so ask if you do not know the exact name.

The first run of each Shortcut stops at an iOS prompt asking to allow its output. Tell the user to tap Always Allow, because the call times out while the prompt waits.

"There was a problem running the shortcut" can come after the actions have already run. Do not run it again until you know, if it sends, posts, buys or deletes anything.

## Create one

\`create_shortcut\` builds a signed \`.shortcut\` file and returns a link. Send the user the link. They tap it on the iPhone, download the file, open it, and tap Add Shortcut.

- Build it when the user asks for one, or when \`run_shortcut\` says it does not exist and they agree.
- Show the user what it will do first if it sends, posts, buys or deletes anything.
- The link has no login, so never put a password or token in a Shortcut.
- It needs the user's Mac awake and on Tailscale. If the signer cannot be reached, say so and give the steps to build it by hand. \`shortcuts://create-shortcut\` opens a blank one.

### Variables

Give an action an \`id\` to use its output later.

- Inside text: \`"Battery is {{level}}%"\`. \`{{input}}\` is the text passed to \`run_shortcut\`.
- For a parameter that takes a whole variable, like \`WFInput\`: \`{"variable": "level"}\`.

\`run_shortcut\` returns the last action's output. Set \`output\` to return something else. It adds Stop and Output at the end.

\`\`\`json
{
  "name": "Chomp Battery",
  "actions": [
    { "action": "getbatterylevel", "id": "level" }
  ],
  "output": "{{level}}"
}
\`\`\`

### Actions

Use a short name below, or the full identifier for anything else. Only \`gettext\` has been run on a phone or simulator. The others come from community docs, so ask the user to check the Shortcut after import.

| Action | Parameters | What it does |
|---|---|---|
| \`gettext\` | \`WFTextActionText\` | A piece of text |
| \`getbatterylevel\` | | Battery level |
| \`getcurrentlocation\` | | Current location |
| \`getclipboard\` | | Read the clipboard |
| \`setclipboard\` | \`WFInput\` as a variable | Write the clipboard |
| \`notification\` | \`WFNotificationActionTitle\`, \`WFNotificationActionBody\` | Show a notification |
| \`speaktext\` | \`WFText\` as a variable | Read text aloud |
| \`ask\` | \`WFAskActionPrompt\` | Ask the user for text |
| \`url\` | \`WFURLActionURL\` | A URL |
| \`downloadurl\` | \`WFURL\`, \`WFHTTPMethod\` | Fetch a URL |
| \`openurl\` | \`WFInput\` as a variable | Open a URL |
| \`com.apple.mobilenotes.SharingExtension\` | \`WFCreateNoteInput\` | Create a note |

An action Shortcuts does not know shows as Unknown Action after import, and a wrong parameter name shows as an empty field. Actions from third-party apps often have identifiers you cannot guess. Then ask the user to add that step by hand, or to show you how it appears.`;

export function appleShortcutsSkill() {
  return {
    name: "apple-shortcuts",
    description: "Reach other apps on the user's iPhone: run an Apple Shortcut and read its output, open a deep link, or create a new Shortcut and send a link to import it. Load when the user wants something done in another iPhone app, or asks for a Shortcut.",
    content: CONTENT,
  };
}
