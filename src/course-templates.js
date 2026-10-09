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
  {
    key: 'food-hygiene',
    name: 'Food hygiene',
    description: 'The 4 Cs – cleaning, cooking, chilling and cross-contamination – plus handwashing, temperatures, dates and labels, and when to stay off work. A refresher for everyone who handles food.',
    renew_months: 36,
    pass_mark: 80,
    needs_signoff: false,
    steps: [
      page('Why food hygiene matters 🧼', `Food poisoning can make people seriously ill – and for babies, pregnant women, older people and anyone unwell, it can be dangerous. Every café is inspected by the council and given a **food hygiene rating** from 0 to 5 that everyone can see.

Everything in this course comes down to the **4 Cs**:
- **Cleaning**
- **Cooking**
- **Chilling**
- **Cross-contamination** (stopping it)

This course is a refresher. If your job needs a food hygiene certificate (e.g. Level 2), your manager will arrange that too.`),
      page('You: hands, clothes and illness', `**Wash your hands** with soap and warm water for at least **20 seconds**, then dry them with a paper towel:
- when you start work and after every break
- after the toilet, smoking, eating or touching your face, hair or phone
- after touching raw meat, raw eggs, unwashed veg, bins or dirty dishes
- after cleaning, and before putting on gloves

**Gloves are not a replacement for handwashing** – change them as often as you’d wash your hands.

**Dress for the job:** clean apron or uniform, long hair tied back, no watches or rings with stones, and cover cuts with a **blue plaster**.

**Illness:** if you have **sickness or diarrhoea**, don’t come in. Tell your manager and stay off until you’ve had no symptoms for **48 hours**. Tell them too if someone you live with has it, or if you have an infected cut or skin rash.`),
      page('Cleaning', `Clean as you go – don’t leave it until closing.

**Two-stage clean** for work surfaces, boards and equipment:
- **1. Clean** – hot soapy water to remove dirt and grease
- **2. Disinfect** – spray with sanitiser, leave it for the **contact time** on the label, then wipe or rinse

Sanitiser sprayed onto a dirty surface doesn’t work – always clean first.

- Use **separate cloths** for different areas and change them often – disposable ones are best
- Follow the **cleaning schedule** and sign it off
- Keep cleaning chemicals away from food
- **Pests:** droppings, gnawed packaging, dead insects or flies – tell your manager straight away and don’t use anything that might be contaminated`),
      page('Cooking and hot holding 🌡️', `Cooking food properly kills harmful bacteria.
- Cook food until it is **steaming hot all the way through** – a probe in the thickest part should read **75°C or above**
- Clean the probe with an antibacterial wipe before and after every use
- Keep hot food you’re serving at **63°C or above**
- **Reheat** food until steaming hot all the way through (75°C or above), and **only reheat once**
- Record temperatures where your site asks you to

Bacteria grow fastest between **8°C and 63°C** – the **danger zone**. Keep food out of it as much as you can.`),
      page('Chilling ❄️', `- Fridges and chilled displays must keep food at **5°C or below** (the legal limit is 8°C – we aim lower)
- Freezers at **–18°C or below**
- Check and **record fridge temperatures** at least twice a day. If a fridge is too warm, tell your manager straight away
- Put deliveries of chilled and frozen food away **first and quickly**
- **Cool hot food quickly** – within **90 minutes** – before it goes in the fridge (spread it out in a shallow tray); never put hot food straight in
- Defrost in the fridge, not on the counter, and never refreeze food that’s been defrosted
- Don’t overfill fridges – cold air needs to move around`),
      page('Stopping cross-contamination', `Cross-contamination is when bacteria (or allergens) spread from one thing to another – from raw food to ready-to-eat food, or via hands, cloths and equipment.
- Store **raw meat and fish at the bottom** of the fridge, covered, below ready-to-eat food
- Use **colour-coded boards and knives**: red raw meat · blue raw fish · yellow cooked meat · green salad and fruit · brown veg · white bread and dairy (purple for allergen-free)
- Wash hands after handling raw food
- Never put cooked or ready-to-eat food on a surface or plate that’s had raw food on it without cleaning it first
- Keep food covered
- Wash fruit and veg that won’t be cooked`),
      page('Dates, labels and stock', `- **Use by** is about safety – never use or sell food after its use-by date, even if it looks and smells fine
- **Best before** is about quality – it may be safe after, but we don’t serve it
- **Label everything** you open, make or defrost with what it is and the date – follow your site’s shelf-life rules (e.g. “use within 3 days”)
- **First in, first out** – put new stock behind the old, and use the oldest first
- Throw away anything unlabelled, out of date or past its shelf life
- Never serve food from a damaged, swollen or blown tin or packet`),
      page('Nearly done ✅', `Remember the **4 Cs**:
- **Cleaning** – clean as you go; clean first, then sanitise
- **Cooking** – 75°C or above in the middle; hot holding at 63°C or above
- **Chilling** – fridges at 5°C or below; cool hot food within 90 minutes
- **Cross-contamination** – raw at the bottom, colour-coded boards, wash hands

And: wash your hands for **20 seconds**, stay off for **48 hours** after sickness or diarrhoea, never use food past its **use-by**, and **label** everything.

Now the questions – you need **80%** to pass.`),
      question('How long should you wash your hands for?', ['5 seconds', 'At least 20 seconds', 'Just a quick rinse is fine'], 1),
      question('You had sickness and diarrhoea last night but feel fine this morning. What do you do?', [
        'Come in – you feel fine now',
        'Come in but wear gloves',
        'Tell your manager and stay off until you’ve had no symptoms for 48 hours',
      ], 2),
      question('What’s the right way to clean a work surface after making sandwiches?', [
        'Spray it with sanitiser and wipe it straight away',
        'Clean it with hot soapy water, then spray with sanitiser and leave it for the contact time',
        'Wipe it with a damp cloth',
      ], 1, 'Sanitiser can’t work on a dirty surface, and needs its contact time to kill bacteria.'),
      question('What temperature should the middle of a cooked toastie or hot food reach?', ['50°C', '63°C', '75°C or above'], 2),
      question('What temperature should a fridge keep food at?', ['5°C or below', '10°C', '15°C'], 0),
      question('Where should raw meat go in the fridge?', ['On the top shelf', 'On the bottom shelf, covered', 'Next to the sandwiches'], 1, 'If it drips, it can’t drip onto ready-to-eat food.'),
      question('A tub of houmous is a day past its use-by date but smells fine. What do you do?', ['Use it today', 'Throw it away', 'Use it for staff food'], 1),
      question('Which colour chopping board is for salad and fruit?', ['Red', 'Blue', 'Green', 'Yellow'], 2),
      question('You see mouse droppings in the stockroom. What do you do?', [
        'Sweep them up and carry on',
        'Tell your manager straight away, and don’t use anything that might be contaminated',
        'Mention it at the end of your shift',
      ], 1),
      question('A batch of soup has just been cooked for tomorrow. What’s the right way to cool it?', [
        'Put the hot pan straight in the fridge',
        'Leave it on the side overnight',
        'Spread it into a shallow container to cool within 90 minutes, then put it in the fridge',
      ], 2),
    ],
  },
  {
    key: 'allergen-awareness',
    name: 'Allergen awareness',
    description: 'The 14 allergens, Natasha’s Law, how to take an allergy order safely, stopping cross-contact behind the bar, and what to do if someone has a severe reaction.',
    renew_months: 12,
    pass_mark: 80,
    needs_signoff: false,
    steps: [
      page('Why allergens matter ⚠️', `For someone with a food allergy, even a tiny amount – a splash of the wrong milk, a crumb of a nut – can cause a severe reaction, and people die from them every year in the UK.

The law says we must be able to tell customers if any of the **14 allergens** are in what we sell, and give them accurate information. Getting it wrong can mean someone gets seriously ill, and the business – and the person who served them – can be prosecuted.

**The golden rule: never guess.** If you’re not 100% sure, check the allergen information or ask your manager.`),
      page('The 14 allergens', `These are the 14 allergens we must tell customers about:
- **Celery** (including celeriac)
- **Cereals containing gluten** – wheat, rye, barley, oats
- **Crustaceans** – prawns, crab, lobster
- **Eggs**
- **Fish**
- **Lupin** – a flour sometimes used in bread and pastries
- **Milk**
- **Molluscs** – mussels, oysters, squid
- **Mustard**
- **Tree nuts** – almonds, hazelnuts, walnuts, cashews, pecans, pistachios and more
- **Peanuts**
- **Sesame**
- **Soya**
- **Sulphites** – often in dried fruit, wine and some drinks

They hide in places you might not expect – milk in some bread, nuts in pesto and some syrups, soya in plant milks, sesame in seeded breads.`),
      page('Natasha’s Law and our labels', `**Natasha’s Law** came in after Natasha Ednan-Laperouse died from an allergic reaction to a baguette that had sesame baked into it, with no allergen label.

Since October 2021, food that’s **prepacked for direct sale** – made and packed here before a customer orders it, like sandwiches, salads and cakes wrapped and put in the chiller – must have a label with:
- the **name** of the food
- the **full ingredients list**, with the **allergens in bold**

**What this means for you:**
- Always use the right, up-to-date label when you pack something
- If the recipe or an ingredient changes, the label must change too – tell your manager
- Never put a product out without its label`),
      page('Taking an allergy order', `When a customer tells you about an allergy:
- **Take it seriously every time**, whether it’s an allergy, intolerance or preference – you can’t tell how serious it is
- **Check the allergen information** for that exact item – don’t rely on memory, recipes and suppliers change
- If you’re not sure, **tell them you’re not sure** and ask your manager. It’s fine to say “I’m sorry, I can’t guarantee that’s safe for you”
- **Never guess** and never say something is “probably fine”
- Tell whoever is making it, and make sure the right item gets to the right customer
- Be honest about **“may contain”** – if we can’t control cross-contact, say so`),
      page('Stopping cross-contact behind the bar ☕', `Allergens can transfer from one food to another on hands, equipment and surfaces.
- Use a **separate, clean jug** for each plant milk and for cow’s milk – never share jugs
- **Purge and wipe the steam wand** before steaming milk for an allergy order
- Wash your hands and use **clean tongs, knives and boards** (purple if you have them)
- Make allergy orders **first**, on a clean surface, away from other food
- Watch out for **toppings, syrups and sauces** – some contain nuts or milk
- Keep allergy orders **covered and separate** until they go out`),
      page('If someone has a severe reaction 🚑', `Signs of a severe reaction (**anaphylaxis**) can start within minutes:
- swelling of the throat, tongue or lips
- difficulty breathing, wheezing or a hoarse voice
- feeling faint, dizzy or confused, or collapsing
- pale, clammy skin; a rash may or may not appear

**What to do:**
- **Call 999 straight away** and say “**anaphylaxis**”
- If they have an **adrenaline auto-injector** (like an EpiPen), help them use it – into the outer thigh
- Get the manager and a first aider
- If they feel faint, help them **lie down with their legs raised**; if they’re struggling to breathe, let them **sit up**
- If there’s no improvement after **5 minutes** and they have a second auto-injector, it can be used
- Don’t leave them alone, and don’t let them stand up or walk`),
      page('Nearly done ✅', `Remember:
- There are **14 allergens** – know where to find the allergen information for everything we sell
- **Never guess** – check, and ask your manager if you’re unsure
- **Natasha’s Law** – prepacked food made here needs a full label with allergens in bold
- **Separate jugs** for every milk, purge the steam wand, clean tongs and surfaces
- **Anaphylaxis: call 999** and help them use their auto-injector

Now the questions – you need **80%** to pass.`),
      question('How many allergens must we tell customers about?', ['8', '12', '14', '20'], 2),
      question('Which of these is one of the 14 allergens?', ['Tomato', 'Sesame', 'Chocolate', 'Sugar'], 1),
      question('A customer asks if the banana bread is nut-free and you’re not sure. What do you say?', [
        '“It should be fine”',
        '“Let me check the allergen information for you” – and ask the manager if it’s still unclear',
        '“Nothing here has nuts”',
      ], 1),
      question('A customer with a milk allergy orders an oat latte. What do you do with the milk jug?', [
        'Use the same jug, rinsed under the tap',
        'Use a separate clean jug, and purge and wipe the steam wand first',
        'It doesn’t matter – oat milk has no milk in it',
      ], 1),
      question('Natasha’s Law means sandwiches we make and wrap before customers order need…', [
        'A price label only',
        'A label with the name and full ingredients, with allergens in bold',
        'A “may contain nuts” sticker',
      ], 1),
      question('A customer says they’re “just avoiding gluten”. How should you treat it?', [
        'As less important than an allergy',
        'Seriously – check the allergen information the same way as for an allergy',
        'Ignore it',
      ], 1, 'You can’t tell how serious it is – it might be coeliac disease.'),
      question('A customer’s lips and throat start swelling and they’re struggling to breathe. What do you do first?', [
        'Give them a glass of water',
        'Call 999, say “anaphylaxis”, and help them use their auto-injector if they have one',
        'Wait to see if it passes',
      ], 1),
      question('A supplier has changed the brownie recipe. What should happen?', [
        'Nothing, a brownie is a brownie',
        'Tell your manager so the allergen information and labels are updated',
        'Take the old label off',
      ], 1),
    ],
  },
  {
    key: 'serving-alcohol',
    name: 'Serving alcohol responsibly',
    description: 'For anyone serving alcohol: the licensing objectives, Challenge 25 and accepted ID, refusing a sale, proxy sales and serving people who are drunk.',
    renew_months: 12,
    pass_mark: 80,
    needs_signoff: false,
    steps: [
      page('Selling alcohol – the law 🍷', `Anywhere that sells alcohol needs a **premises licence**, and every sale is made under the authority of the **Designated Premises Supervisor** (DPS). If you serve alcohol, **you personally** can be fined for breaking the law – not just the business.

Licensed premises must support the **four licensing objectives**:
- **Prevention of crime and disorder**
- **Public safety**
- **Prevention of public nuisance**
- **Protection of children from harm**

It’s against the law to:
- sell alcohol to anyone **under 18**
- buy alcohol for someone under 18 (a **proxy sale**)
- sell alcohol to someone who is **drunk**, or buy it for them`),
      page('Challenge 25', `We follow **Challenge 25**: if a customer looks **under 25**, ask them for ID – every time, however busy you are.

**ID we accept** – it must have a photo and date of birth, and be in date:
- a **passport**
- a **photo driving licence**
- a proof of age card with the **PASS hologram**
- a **military ID** card

**Checking ID:**
- Hold it – don’t just glance at it
- Check the **photo** matches the person
- Check the **date of birth** – are they 18 or over today?
- Check it hasn’t been tampered with and isn’t out of date

**No ID, no sale.** Photocopies, photos on a phone, bank cards and student cards aren’t accepted.`),
      page('Refusing a sale', `Refusing a sale is part of the job – you’re protecting yourself and the business.
- Stay **calm and polite**: “I’m sorry, I can’t serve you without ID – it’s the law”
- Don’t argue or get drawn into a debate
- **Get the manager** if the customer becomes difficult
- **Record the refusal** in the refusals log (date, time, a description and why)

**Proxy sales:** if you think an adult is buying alcohol for someone under 18 – for example a younger person hands them money or tells them what to buy – refuse the sale.

**Children:** 16 and 17-year-olds may drink beer, wine or cider **with a table meal** if an adult buys it and they’re with an adult. They can’t buy it themselves.`),
      page('Customers who’ve had too much', `It’s illegal to serve someone who is drunk. Signs include:
- slurred speech, being loud or repeating themselves
- unsteady on their feet, clumsy, spilling drinks
- glazed eyes, drowsiness
- being aggressive, overfriendly or rude

**What to do:**
- Don’t serve them any more alcohol – offer water, a soft drink or something to eat
- Be polite, discreet and **don’t embarrass them**
- Tell your manager
- Keep yourself safe – if anyone becomes aggressive, step away and let your manager deal with it. Call **999** if anyone is in danger
- If someone is very unwell, get help – don’t leave them alone`),
      page('Nearly done ✅', `Remember:
- **Challenge 25** – anyone who looks under 25 shows ID
- Accept only **passport, photo driving licence, PASS card or military ID**
- **No ID, no sale** – and record every refusal
- Never sell to someone **under 18**, a **proxy** or someone who is **drunk**
- **You** can be fined personally

Now the questions – you need **80%** to pass.`),
      question('Under Challenge 25, who should you ask for ID?', ['Only people who look under 18', 'Anyone who looks under 25', 'Only people buying spirits'], 1),
      question('Which of these is accepted as ID?', ['A bank card', 'A photo of a passport on their phone', 'A proof of age card with the PASS hologram', 'A student card'], 2),
      question('A customer who looks about 20 says they left their ID at home. What do you do?', [
        'Serve them if they tell you their date of birth',
        'Politely refuse the sale and record it in the refusals log',
        'Serve them just this once',
      ], 1),
      question('An adult is buying two bottles of wine, and a teenager outside handed them the money. What do you do?', [
        'Serve them – the adult is over 18',
        'Refuse the sale – it looks like a proxy sale',
        'Serve one bottle only',
      ], 1),
      question('A customer is slurring, unsteady and asks for another glass of wine. What do you do?', [
        'Serve them – they’re paying',
        'Serve a small glass',
        'Don’t serve more alcohol – politely offer water or food and tell your manager',
      ], 2),
      question('Who can be fined for selling alcohol to someone under 18?', ['Only the owner', 'Only the manager', 'You personally, as well as the business'], 2),
    ],
  },
  {
    key: 'customer-service',
    name: 'Great customer service',
    description: 'How we welcome people, take orders right, keep the café looking its best, help everyone who visits, and turn a complaint around.',
    renew_months: null,
    pass_mark: 80,
    needs_signoff: false,
    steps: [
      page('Why it matters 😊', `People can get a coffee anywhere. They come back to us because of **how we make them feel**.

Great service doesn’t mean a script – it means being **friendly, quick, accurate and genuinely interested** in the people in front of you. A regular whose name and order you remember will tell their friends about us.`),
      page('The welcome', `- **Acknowledge everyone straight away** – a smile, eye contact or “I’ll be right with you” – even when you’re busy
- **Greet them** like you’re pleased to see them
- Put your phone away and stop side conversations when a customer is waiting
- Learn your **regulars’** names and usual orders
- Keep the queue moving – if it’s getting long, ask for help`),
      page('Taking the order right', `- **Listen**, and repeat the order back if it’s complicated
- Ask about **size, milk, eat in or take away** so there are no surprises
- Ask about **allergies** for food, and always check the allergen information if they mention one
- Suggest, don’t push – “Would you like a pastry with that?” or mention a special
- Call out orders clearly, using the name if you have one
- **Check every drink and plate** before it goes out – would you be happy to be served it?`),
      page('Keeping the café looking good', `People notice the details:
- Clear and wipe tables quickly
- Keep the counter, condiments station and toilets clean and stocked
- Make sure the music, lighting and temperature feel right
- Keep cakes and displays full and tidy, and take anything past its best away
- Pick up litter outside the door`),
      page('Helping everyone', `Everyone should feel welcome:
- Offer help, but don’t assume – ask “Can I help with anything?”
- Offer to **carry a tray** for anyone who might find it hard – people with prams, mobility aids or young children
- Speak clearly and face people when you talk – some customers lip-read
- Be patient with anyone who needs more time
- Assistance dogs are always welcome
- Know where the accessible toilet and step-free entrance are`),
      page('When something goes wrong – LAST', `Complaints are a chance to win someone back. Use **LAST**:
- **L**isten – let them finish without interrupting
- **A**pologise – “I’m really sorry about that” (it isn’t admitting blame, it’s showing you care)
- **S**olve – remake the drink, replace the food, or get your manager
- **T**hank – “Thanks for letting us know”

Stay calm and don’t take it personally. Get your manager if you can’t fix it, if they want a refund you can’t give, or if anyone becomes aggressive.`),
      question('The queue is long and a customer walks in. What should you do?', [
        'Ignore them until you’re ready',
        'Acknowledge them straight away with a smile or “I’ll be right with you”',
        'Tell them it’s busy',
      ], 1),
      question('A customer says their latte is cold. What’s the best response?', [
        'Tell them it was hot when it left the bar',
        'Apologise and remake it straight away',
        'Offer to microwave it',
      ], 1),
      question('What does LAST stand for?', ['Look, Ask, Serve, Tell', 'Listen, Apologise, Solve, Thank', 'Listen, Argue, Settle, Talk'], 1),
      question('A customer with a pram and a toddler orders two drinks and a cake. What could you do?', [
        'Nothing – they can manage',
        'Offer to bring their order to the table',
        'Ask them to come back for the cake',
      ], 1),
      question('A customer mentions a nut allergy when ordering a cake. What do you do?', [
        'Say it should be fine',
        'Check the allergen information, and ask your manager if unsure',
        'Recommend a different café',
      ], 1),
    ],
  },
  {
    key: 'till-cash-handling',
    name: 'Till and cash handling',
    description: 'Using the till properly, taking card and cash payments, spotting fake notes, refunds, cashing up and staying safe with money.',
    renew_months: null,
    pass_mark: 80,
    needs_signoff: true,
    steps: [
      page('Looking after the money 💷', `Every penny that goes through the till needs to be accounted for. Most mistakes happen when people rush, so **take your time** with money, even when it’s busy.

Ground rules:
- **Only use your own login** on the till – never someone else’s, and never share yours
- **Ring every sale through the till** before you take payment
- **No personal money, phones or bags** at the till
- Never leave the till drawer open, and **lock or log out** when you step away
- Never take money from the till for any reason (change for yourself, petty cash) unless your manager says so and it’s recorded`),
      page('Taking payments', `**Card and contactless**
- Let the customer tap or insert their own card – don’t take it from them unless they ask
- Never write down or ask for a PIN
- Wait for the machine to say **approved** before handing over the order

**Cash**
- Say the amount you’ve been given out loud: “That’s from a £20”
- Leave the note **on top of the drawer** until you’ve given the change
- **Count the change back** into the customer’s hand`),
      page('Spotting fake notes 🔍', `Check every **£20 and £50**, and any note that looks or feels wrong. On Bank of England polymer notes check:
- **Feel** – smooth, with raised print on the front
- **See-through windows** – the clear window has a portrait and is crisp, not blurry
- **Holograms** – the images change when you tilt the note
- **Print quality** – sharp, not blurry or smudged

**If you think a note is fake:** stay calm and polite, don’t accuse the customer, and get your manager. Don’t hand it back.`),
      page('Refunds, voids and mistakes', `- **Refunds and voids need a manager** – never do them on your own
- If you make a mistake on the till, tell your manager straight away so it can be fixed properly
- Don’t give refunds in cash for card payments – refund to the same card
- Free drinks and staff discounts must be rung through the till with the right button`),
      page('Cashing up and staying safe', `**Cashing up**
- Count the float at the start of your shift and the takings at the end, ideally with **a second person**
- Count away from customers and windows
- Record the totals and any **over or under** honestly – mistakes happen, hiding them is the problem

**Staying safe**
- Don’t count money in front of customers or talk about how much is in the till
- Keep the safe locked
- **If someone demands money: hand it over.** Don’t argue, chase or try to stop them. Your safety matters far more than the money. Then call **999** and your manager.`),
      question('A colleague is logged into the till and asks you to keep serving on their login. What do you do?', [
        'Carry on – it saves time',
        'Log in as yourself – always use your own login',
        'Use it only for card payments',
      ], 1),
      question('A customer pays for a £3.40 coffee with a £20 note. What should you do with the note?', [
        'Put it in the drawer straight away',
        'Leave it on top of the drawer until you’ve counted their change back',
        'Hand it back to them',
      ], 1),
      question('A customer asks for a refund on a cake they paid for by card. What do you do?', [
        'Give them cash from the till',
        'Get your manager – refunds need a manager, and go back on the same card',
        'Tell them refunds aren’t allowed',
      ], 1),
      question('You think a £20 note might be fake. What do you do?', [
        'Tell the customer it’s fake and hand it back',
        'Stay calm, don’t accuse them, and get your manager',
        'Accept it anyway',
      ], 1),
      question('Someone comes in and demands the money from the till. What do you do?', [
        'Refuse and call for help',
        'Hand it over, don’t chase them, then call 999 and your manager',
        'Try to lock the till',
      ], 1, 'Nothing in the till is worth getting hurt for.'),
      question('At cash-up, the till is £5 short. What do you do?', [
        'Put in £5 of your own money',
        'Record it honestly and tell your manager',
        'Leave it off the sheet',
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
