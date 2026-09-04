import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// PrettyZap's native Quattro bar widget. The bar owns the trigger and the
// PopupCard owns the detail surface; there is no second panel/window here.
BarWidget {
  id: root
  moduleName: "prettyletto.prettyzap"
  property bool popupOpen: false
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  // Omarchy's bar API exposes live palette colors rather than a boolean theme
  // flag. The bar background is the most reliable light/dark signal and
  // re-evaluates automatically when the active Omarchy theme changes.
  readonly property bool isDark: {
    var surface = bar ? bar.background : Color.background
    var luminance = (0.2126 * surface.r) + (0.7152 * surface.g) + (0.0722 * surface.b)
    return luminance < 0.5
  }

  function open() { popupOpen = true }
  function close() { popupOpen = false }
  function toggle() { popupOpen = !popupOpen }
  function statusText() {
    if (!data.installed) return "Not installed"
    if (data.running && !data.ready) return "Starting…"
    if (data.appVisible) return "Open · " + themeLabel()
    if (data.running) return "Hidden · " + themeLabel()
    return "Closed"
  }
  function themeLabel() {
    return data.theme === "system" ? "System theme" : "WhatsApp theme"
  }
  function toggleApp() { data.toggle() }
  function handleBarClick(buttonCode) {
    if (buttonCode === Qt.RightButton) root.toggle()
    else if (buttonCode === Qt.MiddleButton) data.openSettings()
    else if (!data.installed) root.open()
    else data.toggle()
  }
  // Quattro's bar host and keyboard panel dispatch module clicks through this
  // contract. The app owns the authoritative visibility decision; the status
  // file is only a presentation hint for this widget.
  function triggerPress(buttonCode) { handleBarClick(buttonCode) }
  Data { id: data }

  Component.onCompleted: {
    data.launchCommand = String(setting("launchCommand", "uwsm-app -- prettyzap"))
    root.showBrand = String(setting("icon", "glyph")) === "brand"
  }

  // This follows Quattro's documented third-party bar-widget pattern: the
  // entry point is a BarWidget with explicit geometry and a plain MouseArea.
  implicitWidth: Style.bar.statusSlot
  implicitHeight: barSize

  // Icon surface: the declared `icon` setting switches between the themed
  // PrettyZap brand mark and the WhatsApp glyph.
  property bool showBrand: false

  // How unread messages are surfaced. "count" draws the numeric badge,
  // "highlight" recolours the glyph and its halo with the bar's alert colour
  // and draws nothing extra, "none" leaves the icon alone. Anything
  // unrecognised falls back to the badge, which is the historical behaviour.
  readonly property string badgeMode: {
    var v = String(setting("badge", "Count")).toLowerCase()
    return (v === "highlight" || v === "none") ? v : "count"
  }
  readonly property bool hasUnread: data.unreadCount > 0
  readonly property bool highlightActive: root.badgeMode === "highlight" && root.hasUnread
  readonly property color alertColor: root.bar ? root.bar.urgent : Color.urgent
  readonly property string badgeLabel:
    root.badgeMode === "highlight" ? "Highlight icon"
    : root.badgeMode === "none" ? "None" : "Count"

  function cycleBadge() {
    var next = root.badgeMode === "count" ? "Highlight"
      : root.badgeMode === "highlight" ? "None" : "Count"
    root.persist("badge", next)
  }

  // Write one setting back to this widget's entry in shell.json, preserving
  // every other key on it.
  function persist(key, value) {
    var entry = { id: root.moduleName }
    for (var k in root.settings) {
      if (k !== "id") entry[k] = root.settings[k]
    }
    entry[key] = value
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  Image {
    visible: root.showBrand
    anchors.centerIn: parent
    // The supplied mark has transparent padding, so give it a larger surface
    // than the text glyph while keeping it within the bar's vertical bounds.
    width: Math.min(barSize, Style.space(24))
    height: Math.min(barSize, Style.space(24))
    source: Qt.resolvedUrl(root.isDark
      ? "assets/prettyzap-widget-dark.png"
      : "assets/prettyzap-widget-light.png")
    sourceSize.width: 32
    sourceSize.height: 32
    fillMode: Image.PreserveAspectFit
  }

  Text {
    visible: !root.showBrand
    anchors.centerIn: parent
    text: "󰖣"
    color: root.highlightActive ? root.alertColor : Color.accent
    opacity: data.running ? 0.16 : 0
    scale: 1.55
    font.family: root.bar ? root.bar.fontFamily : Style.font.family
    font.pixelSize: Style.bar.iconFont + Style.space(2)
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
  }

  Text {
    visible: !root.showBrand
    anchors.centerIn: parent
    text: "󰖣"
    color: root.highlightActive ? root.alertColor : Color.accent
    opacity: data.running ? 0.28 : 0
    scale: 1.24
    font.family: root.bar ? root.bar.fontFamily : Style.font.family
    font.pixelSize: Style.bar.iconFont + Style.space(2)
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
  }

  Text {
    visible: !root.showBrand
    anchors.centerIn: parent
    text: "󰖣"
    color: root.highlightActive ? root.alertColor
      : (data.running ? Color.accent : root.foreground)
    font.family: root.bar ? root.bar.fontFamily : Style.font.family
    font.pixelSize: Style.bar.iconFont + Style.space(2)
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
  }

  Rectangle {
    visible: data.badgeEnabled && root.hasUnread && root.badgeMode === "count"
    // Pin the badge to the glyph, not the bar. The glyph is centred, so
    // anchoring to parent.top detaches the badge on any bar taller than the
    // 26px default -- it drifts upward and stops reading as part of the icon.
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.horizontalCenterOffset: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    anchors.verticalCenterOffset: -Style.space(7)
    width: data.unreadCount >= 100
      ? Style.space(24)
      : data.unreadCount >= 10 ? Style.space(17) : Style.space(14)
    height: Style.space(14)
    radius: height / 2
    color: "#d9485f"
    border.color: root.foreground
    border.width: 1

    Text {
      anchors.centerIn: parent
      text: data.unreadCount >= 100 ? "99+" : String(data.unreadCount)
      color: "white"
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: data.unreadCount >= 100 ? 7 : 8
      font.bold: true
    }
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) { root.handleBarClick(mouse.button) }
  }

  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(280))
    contentHeight: popup.fittedContentHeight(contentColumn.implicitHeight)

    Column {
      id: contentColumn
      width: parent.width
      spacing: Style.space(10)

      Row {
        width: parent.width
        spacing: Style.space(10)

        Text {
          width: Style.space(36)
          height: Style.space(36)
          text: "󰖣"
          color: root.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.title
          horizontalAlignment: Text.AlignHCenter
          verticalAlignment: Text.AlignVCenter
        }

        Column {
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          Text {
            text: "PrettyZap"
            color: root.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }

          Text {
            text: root.statusText()
            color: Qt.darker(root.foreground, 1.45)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }
      }

      PanelSeparator {
        visible: data.installed
        foreground: root.foreground
      }

      Button {
        width: parent.width
        visible: data.installed
        text: data.appVisible ? "Hide PrettyZap" : "Open PrettyZap"
        iconText: data.appVisible ? "󰍃" : "󰖰"
        leftAlign: true
        foreground: root.foreground
        onClicked: {
          root.toggleApp()
          root.close()
        }
      }

      Column {
        visible: !data.installed
        width: parent.width
        spacing: Style.space(6)

        Text {
          width: parent.width
          text: "PrettyZap is not installed. Install it manually from the AUR, then reopen the app:"
          color: root.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          width: parent.width
          text: "yay -S --needed prettyzap-bin"
          color: root.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WrapAnywhere
        }
      }

      Button {
        width: parent.width
        visible: data.installed
        text: "Settings"
        iconText: "󰒓"
        leftAlign: true
        foreground: root.foreground
        onClicked: { data.openSettings(); root.close() }
      }

      Button {
        width: parent.width
        visible: data.installed
        text: "Colors…"
        iconText: "󰏘"
        leftAlign: true
        foreground: root.foreground
        onClicked: { data.openSettings(); root.close() }
      }

      Button {
        width: parent.width
        visible: data.installed
        text: data.theme === "system" ? "Use WhatsApp theme" : "Use System theme"
        iconText: "󰔎"
        leftAlign: true
        foreground: root.foreground
        enabled: data.running
        onClicked: { data.toggleTheme(); root.close() }
      }

      Button {
        width: parent.width
        visible: data.installed
        text: data.notificationsEnabled ? "Disable notifications" : "Enable notifications"
        iconText: data.notificationsEnabled ? "󰂛" : "󰂚"
        leftAlign: true
        foreground: root.foreground
        enabled: data.notificationControlReady
        onClicked: { data.toggleNotifications(); root.close() }
      }

      Button {
        width: parent.width
        text: "Unread: " + root.badgeLabel
        iconText: "󰎟"
        leftAlign: true
        foreground: root.foreground
        onClicked: root.cycleBadge()
      }

      Button {
        width: parent.width
        visible: data.installed
        text: data.badgeEnabled ? "Hide badge" : "Show badge"
        iconText: "󰃨"
        leftAlign: true
        foreground: root.foreground
        enabled: data.badgeControlReady
        onClicked: { data.toggleBadge(); root.close() }
      }

      Button {
        width: parent.width
        visible: data.installed
        text: "Quit PrettyZap"
        iconText: "󰗼"
        leftAlign: true
        foreground: root.foreground
        enabled: data.running
        onClicked: { data.quit(); root.close() }
      }
    }
  }
}
