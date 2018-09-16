import game_API
import fileinput
import json
import random

first_line = True

stances = ["Rock", "Paper", "Scissors"]

for line in fileinput.input():
    if first_line:
        game = game_API.Game(json.loads(line))
        first_line = False
        continue
    game.update(json.loads(line))

    # YOUR CODE BELOW

    #destination_node = game.get_adjacent_nodes(game.get_self().location)[0]
    paths = game.shortest_paths(game.get_self().location, 3)
    if len(paths) > 0 and len(paths[0]) > 0:
        destination_node = paths[0][0]
    else:
        destination_node = 3

    chosen_stance = stances[random.randint(0, 2)]

    # YOUR CODE ABOVE

    game.submit_decision(destination_node, chosen_stance)
