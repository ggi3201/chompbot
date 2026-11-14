const CONTENT = `# The iPhone widget

Chomp's iPhone app has a home and lock screen widget. You fill it with time-windowed cards. The phone stores them and switches between them by itself, also with no network. Use it for what the user should see at a glance at a certain time: when to leave, what is next today, the gate and seat of a flight.

Use it without being asked when the user mentions a trip or a time they must not miss, and offer it when you are unsure. Always tell the user which cards you published and their times, so they can catch a wrong one.

## When the user asks for help with the widget or the phone

The user wants a menu, not a manual (user, 2026-11-07). When they ask for widget or phone help without a concrete job, answer with generative UI: a short table of what the phone can do, then a \`choice\` block of ready-made widget ideas built from their own life, so one tap starts the work. Fill the ideas from what you know now (calendar, trips, portfolio catalysts, football), not from the generic list below, and skip the menu when they already asked for something specific.

What to show, picking the ones that fit:

| On the phone | Examples |
|---|---|
| Widget cards with countdowns | Leave-time for a flight, kickoff countdown, earnings date for an open position, "pick up the kids at 16:00" |
| Alerts the phone schedules itself | "Leave in 15 minutes", "Oven done", "Earnings after close tonight" |
| Boards per widget | \`travel\` on the lock screen, \`today\` on the home screen, \`home\` for chores and the house |
| Tap-through links | Boarding pass, Maps route, a booking, a Chomp chat |
| Phone tools (\`phone_call_tool\`) | Health (sleep, steps, heart rate), calendar and reminders, read a photo, clipboard, speak or vibrate, run a Shortcut |

\`\`\`
:::canvas
{"type":"choice","title":"Put something on your phone","options":[
 {"label":"Trip card: when to leave for Thursday's flight","value":"Make widget cards for my next trip"},
 {"label":"Today board: my day at a glance every morning","value":"Put my day on the today board every morning"},
 {"label":"Match day: kickoff countdown","value":"Add my team's next match to my widget"},
 {"label":"Earnings countdown for my open positions","value":"Put upcoming earnings for my positions on the widget"},
 {"label":"Sleep and steps check-in at 21:00","value":"Make an evening health card from my phone data"}]}
:::
\`\`\`

## Tools

- \`publish_phone_cards\`: publishes a group of cards. Publishing a group again replaces all of it.
- \`list_phone_cards\`: shows what is on the widget. Check it before you publish, so you reuse the group name.
- \`remove_phone_cards\`: removes a group and its alerts, for example a cancelled trip.

If \`publish_phone_cards\` returns an error saying the phone was not reached, the cards are still saved. Tell the user they arrive when the widget refreshes or the app opens.

## A card

| Field | Use |
|---|---|
| \`showFrom\`, \`showUntil\` | When it shows. ISO 8601 with an offset, e.g. 2026-11-10T12:50:00+01:00. Use the user's timezone, and the correct offset for that date |
| \`headline\` | The one thing to know. At most 48 characters. Lead with the action or the time |
| \`detail\` | One supporting fact. At most 60 characters |
| \`countdownTo\` | A live countdown to this moment, usually the time to leave |
| \`icon\` | SF Symbol: \`airplane\`, \`tram.fill\`, \`bus.fill\`, \`car.fill\`, \`figure.walk\`, \`bag.fill\`, \`bed.double.fill\`, \`calendar\`, \`house.fill\`, \`fork.knife\`, \`cross.case.fill\`, \`exclamationmark.triangle.fill\` |
| \`tone\` | \`urgent\` colours the card red. Keep it for the moment to act |
| \`rows\` | Up to 4 label and value pairs, most important first. Labels at most 14 characters, values at most 22 |
| \`alerts\` | Notifications the phone schedules for itself: \`{at, text}\`. A widget cannot get attention, so anything that must be noticed needs one |
| \`link\` | What a tap on the card or its alert opens: a boarding pass, a booking, a map route |
| \`source\`, \`checkedAt\` | Where the facts came from and when you checked them. Shown as "Airport train, checked 11:40". Set them for anything that can change |

Set \`board\` on the group to sort it: \`travel\`, \`today\` or \`home\`. Each widget on the phone shows one board or all of them.

## How the widget shows cards

- Only cards inside their time window show. The one that ends first is on top.
- Small shows one card. Medium shows two, or one and what is next. Large shows three, and what is next. The lock screen shows the top card's headline, with its countdown or detail.
- "Up next" lists cards from other groups that have not started yet. It shows their headline, plus the weekday if it is another day, so put the time in the headline.
- Rows that do not fit are left out. In medium and large, each card opens its own link. Small opens the top card's link.
- A rejected card names the field that is too long. Shorten it. Do not split one fact across fields.

## Recipes

**A trip.** One group per trip, one card per stage, and the windows follow each other with no gap. Work back from the departure, and include the travel time and a margin. Find the details in the calendar and Gmail. To know where the user starts from, use \`get_location\`. If that is too old for the trip, ask.

\`\`\`json
{
  "group": "trip-2026-11-10",
  "board": "travel",
  "cards": [
    { "showFrom": "2026-11-10T07:00:00+01:00", "showUntil": "2026-11-10T12:30:00+01:00",
      "icon": "airplane", "headline": "Leave the office at 12:50", "detail": "Airport train 13:30, BA304 at 15:05",
      "rows": [{ "label": "Gate", "value": "Not set yet" }, { "label": "Seat", "value": "14A" }] },
    { "showFrom": "2026-11-10T12:30:00+01:00", "showUntil": "2026-11-10T12:50:00+01:00",
      "icon": "figure.walk", "headline": "Leave at 12:50", "detail": "Airport train 13:30 from the central station",
      "countdownTo": "2026-11-10T12:50:00+01:00",
      "alerts": [{ "at": "2026-11-10T12:35:00+01:00", "text": "Leave in 15 minutes" }] },
    { "showFrom": "2026-11-10T12:50:00+01:00", "showUntil": "2026-11-10T13:30:00+01:00",
      "icon": "tram.fill", "tone": "urgent", "headline": "Leave now", "detail": "Airport train 13:30 from the central station",
      "alerts": [{ "at": "2026-11-10T12:50:00+01:00", "text": "Time to go" }] }
  ]
}
\`\`\`

**Keep a trip fresh.** Use \`schedule_one_off\` with an agent run a few hours before leaving, to check for delays and publish the group again. If a countdown moves, the phone gets a visible "Time changed" notification by itself, so do not send your own.

**A day at a glance.** Publish a group named \`today-YYYY-MM-DD\` on the \`today\` board from a rule, one card per thing that matters, each shown in the hours before it happens.

## What it cannot do

- It has no live traffic. A leave time is your estimate, and it stays as published until you publish again. Say so when it is an estimate. \`get_location\` tells you where they start from.
- It cannot show charts, images or canvas blocks. For those, use a dashboard.
- A new card can arrive late: iOS limits background pushes, and the phone must reach Chomp over Tailscale to fetch it. Published cards and alerts already on the phone work offline. Do not rely on a change reaching the phone in the last few minutes, and also send it in the chat.`;

export function phoneWidgetSkill() {
  return {
    name: "phone-widget",
    description: "Put time-windowed cards on the user's iPhone widget: when to leave for a trip, what is next today, gate and seat. Load when a trip or a time they must not miss comes up, or when they ask about the widget or what the phone can do.",
    content: CONTENT,
  };
}
