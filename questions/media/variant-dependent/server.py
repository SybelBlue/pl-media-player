import random


def generate(data):
    choice = random.choice(
        [
            {"file_name": "north.wav", "answer": "north"},
            {"file_name": "south.wav", "answer": "south"},
        ]
    )
    data["params"]["selected_clip"] = choice["file_name"]
    data["correct_answers"]["code_word"] = choice["answer"]
