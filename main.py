import asyncio
import logging
import sys

from config import load_config
from bot_manager import BotManager


def setup_logging() -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(name)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    root.addHandler(handler)


async def main() -> None:
    setup_logging()
    logger = logging.getLogger("main")

    configs = load_config()
    if not configs:
        logger.error("No valid bot configurations found")
        return

    manager = BotManager()
    for config in configs:
        manager.add_bot(config)

    await manager.start_all()
    logger.info("All bots started. Press Ctrl+C to stop.")

    try:
        await manager.run_forever()
    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("Shutting down...")
    finally:
        await manager.stop_all()
        logger.info("Shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
