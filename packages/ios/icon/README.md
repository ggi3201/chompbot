`chomp-icon.svg` is the source of the app icon: a flat ember C on graphite.

To regenerate `Chomp/Assets.xcassets/AppIcon.appiconset/icon-1024.png`:

```bash
qlmanage -t -s 1024 -o /tmp icon/chomp-icon.svg
magick /tmp/chomp-icon.svg.png -background '#141415' -alpha remove -alpha off Chomp/Assets.xcassets/AppIcon.appiconset/icon-1024.png
```

App Store Connect rejects an icon with an alpha channel, so check it with `sips -g hasAlpha`.
