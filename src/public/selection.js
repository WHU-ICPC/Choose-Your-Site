export function selectionPreview(options, people, person, preferences) {
  const remaining = new Map(options.map(option => [option.id, option.capacity]));
  const excluded = new Set();
  for (const previous of people) {
    if (previous.number >= person.number) continue;
    if (previous.confirmedAt != null && previous.confirmedChoice != null) {
      remaining.set(previous.confirmedChoice, remaining.get(previous.confirmedChoice) - 1);
    }
    if (previous.name === person.name && previous.group === person.group) {
      const choice = previous.lockedAt != null ? previous.choice : previous.confirmedChoice;
      if (choice != null) excluded.add(choice);
    }
  }
  const choice = preferences.find(id => remaining.get(id) > 0 && !excluded.has(id)) ?? null;
  return { remaining, excluded, choice };
}

export function updateConfirmedSelections(data) {
  for (const person of data.people) {
    if (person.confirmedAt != null && person.lockedAt === null) {
      person.confirmedChoice = selectionPreview(data.options, data.people, person, person.preferences).choice;
    }
  }
}
