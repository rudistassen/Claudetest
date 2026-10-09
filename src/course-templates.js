// Ready-made courses a manager can add to People → Learning & development in one tap, then change in the designer
// before publishing. Each is added as a draft, so nothing reaches staff until someone has checked it fits their sites.

const page = (title, body) => ({ kind: 'page', title, body });
const question = (title, options, answer, body = '') => ({ kind: 'question', title, options, answer, body });

export const COURSE_TEMPLATES = [
  {
    key: 'health-safety-induction',
    name: 'Health & safety induction',
    description: 'For everyone new: fire, slips, burns, knives and glass, lifting, chemicals, electrics, allergens and reporting accidents. A manager signs it off once they’ve walked them round the site.',
    renew_months: 12,
    pass_mark: 80,
    needs_signoff: true,
    steps: [
      page('Welcome – staying safe at work 🦺', `Cafés are busy places full of hot water, steam, knives, glass and wet floors. This course covers how we keep you, your team and our customers safe.

By law everyone at work has a part to play. Yours is to:
- **Take care** of yourself and anyone affected by what you do
- **Follow** the training and safe ways of working you’re shown
- **Report** anything unsafe straight away – a hazard, a broken bit of kit or an accident
- **Never** misuse or interfere with anything provided for safety (like fire extinguishers or first aid kits)

If you’re ever unsure how to do something safely, **stop and ask** the manager on duty. Nobody will mind.`),
      page('Your first shift – find these', `On your first shift, your manager will walk you round. Make sure you know where these are at your site:
- The **fire exits** and the **assembly point** outside
- The **fire alarm call points** and **extinguishers** / **fire blanket**
- The **first aid kit** and who the **first aiders** are
- The **accident book**
- The **cleaning chemicals** and their safety sheets
- The **health and safety law poster**

If you work at more than one site, check these at each one – they’re different everywhere.`),
      page('Fire 🔥', `**If the fire alarm goes off or you discover a fire:**
- Raise the alarm (use the nearest call point) and shout “Fire!”
- Help customers to the nearest exit calmly – don’t stop to finish orders or take payments
- **Don’t** collect your belongings and **don’t** use a lift
- Go to the **assembly point** so the manager can check everyone is out
- **Never** go back in until the fire service or manager says it’s safe

**Every day:**
- Keep fire exits, corridors and doors clear – no boxes, bins or deliveries in the way
- **Never prop fire doors open**, even on a hot day – they stop fire and smoke spreading
- Only use an extinguisher if you’ve been trained and it’s safe – your safety comes first
- **Never put water on burning oil** – use the fire blanket and turn off the heat if it’s safe`),
      page('Slips, trips and falls', `Slips and trips are the **most common cause of injury** in cafés and kitchens.
- **Clean up spills straight away** – milk, water, ice and coffee grounds are all slippery. Put out a **wet floor sign** while it dries
- Wear **closed-toe shoes with slip-resistant soles** – no sandals, sliders or canvas pumps
- Keep floors and walkways clear – put deliveries away, tuck cables out of the way
- Use a proper **step stool** to reach high shelves, never a chair, crate or the counter
- Tell your manager about loose mats, damaged flooring or poor lighting`),
      page('Burns and scalds ☕', `The steam wand, hot water tower, ovens, toasters and dishwasher can all cause serious burns.
- **Purge the steam wand** pointing away from you and into a cloth
- Hold jugs by the handle and **don’t overfill** them
- Use **oven gloves** – a damp cloth lets heat straight through
- Let the dishwasher finish and **stand back when you open it** – the steam is scalding
- Say **“Hot behind!”** when carrying hot things past people

**If someone is burnt or scalded:**
- Cool it under **cool running water for 20 minutes**
- Remove rings or watches near the burn (unless they’re stuck to it)
- Cover it loosely with **cling film**
- **No ice, butter or creams**
- Tell the manager and a first aider. Call **999** for large or serious burns`),
      page('Knives and broken glass 🔪', `**Knives**
- Carry knives **pointing down**, by your side, and say “Knife!” when passing people
- Cut on a board that doesn’t slip (put a damp cloth underneath)
- **Never leave knives in a sink of water** – someone could reach in and get cut
- **If a knife falls, step back and let it drop** – never try to catch it

**Broken glass and china**
- Never pick up broken glass with your hands – use a **dustpan and brush**
- Wrap it in paper or put it in a box, label it “broken glass”, and keep it out of the normal bin bag
- **If glass breaks near ice or food, throw it all away** – empty the ice well, clean it and refill it`),
      page('Lifting and carrying 📦', `Milk crates, cases of drinks and bags of coffee are heavy. Before you lift, think **TILE**:
- **T**ask – do you need to lift it at all? Could you use a trolley or split the load?
- **I**ndividual – are you able to lift it on your own? If not, **ask for help**
- **L**oad – how heavy is it, and is it awkward or likely to move?
- **E**nvironment – is the floor clear, dry and well lit?

**Lifting safely:**
- Stand close with your feet apart
- **Bend your knees**, not your back
- Keep the load **close to your body**
- **Don’t twist** – turn with your feet
- Put it down the same way, then adjust its position`),
      page('Cleaning chemicals 🧴', `Cleaning products can burn skin and eyes, and some give off dangerous fumes.
- Only use the products we provide, for the job they’re meant for
- Follow the **label and the dilution instructions**
- **Never mix chemicals** – bleach mixed with descaler or other acids gives off a toxic gas
- Keep them in their **original, labelled containers** – never in drinks bottles or unmarked spray bottles
- Store them **away from food** and below food, never above it
- Wear the **gloves or goggles** the label says to
- The **safety data sheets** show what to do if something goes wrong – ask your manager where they’re kept

If a chemical gets in someone’s eyes, rinse with clean running water for at least 10 minutes and get help.`),
      page('Electricity ⚡', `- Check plugs and cables before you use equipment – **don’t use anything damaged** (frayed cables, cracked plugs, scorch marks)
- If something is faulty, **unplug it if it’s safe, put a “Do not use” sign on it** and tell your manager
- Never touch plugs or switches with **wet hands**
- **Switch off and unplug** grinders, blenders and slicers before cleaning them or clearing a blockage
- Don’t overload sockets or use extension leads that aren’t provided`),
      page('Food safety and allergens', `**Keeping food safe**
- Wash your hands before handling food, after the toilet, after breaks, after touching bins or raw food
- Keep long hair tied back, wear a clean apron and cover cuts with a **blue plaster**
- If you’ve had **sickness or diarrhoea**, don’t come in – tell your manager. Stay off until you’ve been clear for **48 hours**

**Allergens**
There are **14 allergens** we must tell customers about, including milk, nuts, peanuts, gluten, eggs, soya and sesame. Allergic reactions can kill.
- **Never guess.** Check the allergen information for every item and ask the manager if you’re unsure
- Use clean equipment and surfaces for allergy orders – and use a **separate jug for plant milks**
- If a customer has a severe reaction, **call 999** straight away and tell the manager`),
      page('Accidents, near misses and feeling unsafe', `**Accidents**
- Tell the manager on duty about **every accident**, however small – yours or a customer’s
- Get a first aider if someone is hurt, and call **999** in an emergency
- Every accident goes in the **accident book**

**Near misses**
A near miss is something that **could** have hurt someone but didn’t – a shelf that nearly fell, a slip that didn’t end in a fall. **Report these too**, so they get fixed before someone does get hurt.

**Feeling unsafe**
- If a customer is aggressive, stay calm, don’t argue and **don’t put yourself at risk** – get the manager, and call **999** if anyone is in danger
- If you’re pregnant, have a health condition or an injury that affects your work, tell your manager so they can make sure your work is safe for you`),
      page('Nearly done ✅', `That’s the course. Here’s what to remember:
- Know your **fire exits and assembly point**, and keep fire doors shut
- **Clean spills straight away** and wear proper shoes
- Cool burns under **cool running water for 20 minutes**
- **Let falling knives drop**; throw away ice or food near broken glass
- Think **TILE** before you lift
- **Never mix chemicals**
- **Don’t use damaged electrics** – report them
- **Never guess** about allergens
- **Report every accident and near miss**

Now answer the questions. You need **80%** to pass. Once you’ve passed, your manager will walk you round your site and sign it off.`),
      question('The fire alarm goes off while you’re making a customer’s drink. What do you do?', [
        'Finish the drink, then leave',
        'Stop, help customers out of the nearest exit and go to the assembly point',
        'Collect your bag and phone, then leave',
        'Wait to see if it’s a false alarm',
      ], 1, 'Leave straight away. Drinks, payments and belongings can all wait – people can’t.'),
      question('The kitchen is hot, so someone has propped the fire door open with a bin. What should happen?', [
        'It’s fine on a hot day',
        'It’s fine as long as a manager is in',
        'Move the bin and let the door close – fire doors must never be propped open',
      ], 2, 'Fire doors hold back fire and smoke so people can get out.'),
      question('A customer spills a latte on the floor by the counter. What do you do?', [
        'Put a napkin over it',
        'Clean it up straight away and put out a wet floor sign',
        'Leave it until the closing clean',
      ], 1),
      question('A colleague scalds their hand on the steam wand. What’s the right first aid?', [
        'Put ice on it',
        'Put butter or cream on it',
        'Cool it under cool running water for 20 minutes, then tell a first aider',
        'Carry on and see if it blisters',
      ], 2, 'Cool running water for 20 minutes, then cover loosely with cling film. No ice, butter or creams.'),
      question('A knife slides off the counter. What do you do?', [
        'Try to catch it',
        'Step back and let it fall',
        'Stick your foot out to stop it',
      ], 1),
      question('A glass breaks next to the ice well. What do you do?', [
        'Pick the pieces out of the ice',
        'Carry on – the bits will sink to the bottom',
        'Throw away all the ice, clean the ice well and refill it',
      ], 2, 'You can’t be sure you’ve found every piece, so all the ice has to go.'),
      question('A delivery of milk crates needs moving to the fridge. What’s the safest way?', [
        'Bend your back and lift quickly to get it done',
        'Use a trolley or ask for help, bend your knees and keep the load close',
        'Carry as many crates as you can in one go',
      ], 1),
      question('Can you mix bleach with descaler to make it work better?', [
        'Yes, if it’s diluted',
        'Yes, it cleans better',
        'No – mixing chemicals can give off a toxic gas',
      ], 2),
      question('You notice the grinder’s cable is frayed. What do you do?', [
        'Wrap tape round it and keep using it',
        'Keep using it carefully until the end of the shift',
        'Stop using it, unplug it if it’s safe, put a “Do not use” sign on it and tell your manager',
      ], 2),
      question('A customer asks if a cake is nut-free and you’re not sure. What do you do?', [
        'Say it’s probably fine',
        'Check the allergen information and ask the manager – never guess',
        'Tell them to pick something else',
      ], 1),
      question('You cut your finger slightly and put a blue plaster on it. Do you need to tell anyone?', [
        'No, it’s only small',
        'Only if it needs stitches',
        'Yes – tell the manager and record it in the accident book',
      ], 2, 'Every accident is recorded, however small.'),
      question('A shelf nearly falls on you in the stockroom but you’re not hurt. What do you do?', [
        'Nothing – no one was hurt',
        'Report it as a near miss so it gets fixed',
        'Put the shelf back and move on',
      ], 1),
    ],
  },
];

/** The list shown to managers: what each ready-made course is and how long it is. */
export const templateSummaries = () => COURSE_TEMPLATES.map((t) => ({
  key: t.key, name: t.name, description: t.description, renew_months: t.renew_months, needs_signoff: t.needs_signoff,
  pages: t.steps.filter((s) => s.kind === 'page').length,
  questions: t.steps.filter((s) => s.kind === 'question').length,
}));
