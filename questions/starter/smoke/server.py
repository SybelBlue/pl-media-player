import random


def generate(data):
    a = random.randint(2, 12)
    b = random.randint(2, 12)

    data["params"]["a"] = a
    data["params"]["b"] = b
    data["correct_answers"]["sum"] = a + b
