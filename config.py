import logging
import os
import re
from dataclasses import dataclass
from typing import List

from dotenv import load_dotenv


@dataclass
class BotConfig:
    name: str
    token: str
    guild_id: int
    vc_id: int


def load_config() -> List[BotConfig]:
    load_dotenv()
    logger = logging.getLogger("config")

    pattern = re.compile(r"^BOT_(\d+)_TOKEN$")
    bot_indices = set()

    for key in os.environ:
        match = pattern.match(key)
        if match and os.environ[key].strip():
            bot_indices.add(match.group(1))

    configs = []
    for index in sorted(bot_indices, key=int):
        name = f"Bot{index}"
        token = os.environ.get(f"BOT_{index}_TOKEN", "").strip()
        guild_id_str = os.environ.get(f"BOT_{index}_GUILD_ID", "").strip()
        vc_id_str = os.environ.get(f"BOT_{index}_VC_ID", "").strip()

        if not token:
            logger.error(f"{name}: token is missing or empty, skipping")
            continue
        if not guild_id_str:
            logger.error(f"{name}: guild ID is missing or empty, skipping")
            continue
        if not vc_id_str:
            logger.error(f"{name}: VC ID is missing or empty, skipping")
            continue

        try:
            guild_id = int(guild_id_str)
        except ValueError:
            logger.error(f"{name}: guild ID '{guild_id_str}' is not a valid integer, skipping")
            continue

        try:
            vc_id = int(vc_id_str)
        except ValueError:
            logger.error(f"{name}: VC ID '{vc_id_str}' is not a valid integer, skipping")
            continue

        configs.append(BotConfig(name=name, token=token, guild_id=guild_id, vc_id=vc_id))

    return configs
