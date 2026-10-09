-- Session-local API only. Paths and UUIDs arrive as argv, never executable source.
-- iTerm2.sdef maps session id/unique ID to guid and background image to backgroundImagePath.
use framework "Foundation"
use scripting additions

on run argv
    if (count of argv) < 2 then error "Forest bridge requires an operation and session UUID."
    set operation to item 1 of argv
    set targetUUID to item 2 of argv
    if operation is not "read" and operation is not "replace" then error "Unknown forest bridge operation."
    if operation is "replace" and (count of argv) is not 4 then error "Forest replacement requires expected and next image paths."

    tell application "iTerm2"
        repeat with terminalWindow in windows
            repeat with terminalTab in tabs of terminalWindow
                repeat with terminalSession in sessions of terminalTab
                    if (id of terminalSession as text) is targetUUID then
                        set imagePath to background image of terminalSession
                        if imagePath is missing value then set imagePath to ""
                        set outcome to "read"
                        if operation is "replace" then
                            considering case
                                set matchesExpected to (imagePath as text) is (item 3 of argv)
                            end considering
                            if matchesExpected then
                                set background image of terminalSession to item 4 of argv
                                set imagePath to background image of terminalSession
                                if imagePath is missing value then set imagePath to ""
                                considering case
                                    set matchesNext to (imagePath as text) is (item 4 of argv)
                                end considering
                                if matchesNext then
                                    set outcome to "applied"
                                else
                                    set outcome to "rejected"
                                end if
                            else
                                set outcome to "conflict"
                            end if
                        end if
                        set nativeColor to background color of terminalSession
                        set resultValues to {outcome, id of terminalSession as text, imagePath as text, profile name of terminalSession as text, item 1 of nativeColor, item 2 of nativeColor, item 3 of nativeColor}
                        return my encodeResult(resultValues)
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    error "The exact iTerm2 session UUID was not found. Run omp directly in the target iTerm2 pane; inherited IDs from SSH, tmux, or a closed pane cannot be retargeted." number 1701
end run

on encodeResult(resultValues)
    set jsonData to current application's NSJSONSerialization's dataWithJSONObject:resultValues options:0 |error|:(missing value)
    if jsonData is missing value then error "Could not encode the iTerm2 background snapshot."
    return (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
end encodeResult
