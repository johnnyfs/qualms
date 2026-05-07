# Text Interface

This is the maintained text interface for editing and playing the current Dark Qualms story graph.

The default interface is now a prompt CLI with tab completion when `prompt_toolkit` is installed. The older curses box interface is still available with `--curses`.

From the project root:

```sh
./run.sh
./run-dev.sh
```

By default, the interface loads and edits `../stories/stellar/story.qualms.yaml`.
