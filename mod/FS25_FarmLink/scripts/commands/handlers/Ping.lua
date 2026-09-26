-- ping: answers ok, so the bridge can check the whole command path end to end.

FarmLink = FarmLink or {}

FarmLink.CommandChannel.register("ping", {
    args = {},
    execute = function(_ctx, _command)
        return "ok", "pong"
    end,
})
