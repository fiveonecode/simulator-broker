#!/bin/bash

# Apple HIG Designer - iOS Accessibility Audit
# Check iOS app accessibility compliance (VoiceOver, Dynamic Type, etc.)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARNING_COUNT=0

print_success() {
    echo -e "${GREEN}✓ PASS${NC} $1"
    ((PASS_COUNT += 1))
}

print_error() {
    echo -e "${RED}✗ FAIL${NC} $1"
    ((FAIL_COUNT += 1))
}

print_warning() {
    echo -e "${YELLOW}⚠ WARN${NC} $1"
    ((WARNING_COUNT += 1))
}

print_info() {
    echo -e "${BLUE}ℹ INFO${NC} $1"
}

print_section() {
    echo ""
    echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${MAGENTA}$1${NC}"
    echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║      Apple HIG Designer - Accessibility Audit             ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [ -z "$1" ]; then
    print_info "Usage: $0 <file.swift|directory>"
    exit 1
fi

TARGET="$1"

if [ ! -e "$TARGET" ]; then
    print_error "Target not found: $TARGET"
    exit 1
fi

# VoiceOver Support
print_section "1. VOICEOVER SUPPORT"

count_unlabeled_system_images() {
    perl -0ne '
        my $content = $_;
        my $missing = 0;
        my @lines = split /\n/, $content;
        for (my $index = 0; $index < scalar @lines; $index += 1) {
            next unless $lines[$index] =~ /Image\s*\(\s*systemName\s*:/;
            my $modifier_chain = $lines[$index];
            for (my $chain_index = $index + 1; $chain_index < scalar @lines; $chain_index += 1) {
                last unless $lines[$chain_index] =~ /^\s*\./;
                $modifier_chain .= "\n$lines[$chain_index]";
            }
            if ($modifier_chain !~ /\.(accessibilityLabel|accessibilityHidden)\s*\(/) {
                $missing += 1;
            }
        }
        print "$missing\n";
    ' "$1"
}

check_voiceover() {
    if grep -Eq 'Image[[:space:]]*\([[:space:]]*systemName[[:space:]]*:' "$1"; then
        local unlabeled_count
        unlabeled_count="$(count_unlabeled_system_images "$1")"
        if [ "$unlabeled_count" -eq 0 ]; then
            print_success "Images have accessibility labels"
        else
            print_error "$unlabeled_count image(s) missing accessibility labels"
            echo "         Fix: .accessibilityLabel(\"Description\")"
        fi
    fi

    if grep -q '\.accessibilityHint' "$1"; then
        print_success "Accessibility hints provided"
    fi

    if grep -q '\.accessibilityElement(children: .combine)' "$1"; then
        print_success "Grouping accessibility elements"
    fi
}

# Dynamic Type
print_section "2. DYNAMIC TYPE"

check_dynamic_type() {
    if grep -q '\.font(.body)\|\.font(.headline)\|\.font(.title)' "$1"; then
        print_success "Using system text styles (Dynamic Type supported)"
    else
        print_error "Not using system text styles"
        echo "         Fix: Use .font(.body) instead of .font(.system(size: 17))"
    fi

    if grep -q '\.font(.custom(' "$1"; then
        if grep -q 'relativeTo:' "$1"; then
            print_success "Custom fonts support Dynamic Type"
        else
            print_error "Custom fonts don't support Dynamic Type"
            echo "         Fix: .font(.custom(\"Font\", size: 17, relativeTo: .body))"
        fi
    fi
}

# Color Contrast
print_section "3. COLOR CONTRAST"

check_color_contrast() {
    if grep -q 'Color(.label)\|Color(.secondaryLabel)' "$1"; then
        print_success "Using semantic text colors (good contrast)"
    else
        print_warning "Verify color contrast ratios (4.5:1 minimum)"
    fi

    if grep -q '@Environment(.*colorSchemeContrast)' "$1"; then
        print_success "Supporting Increase Contrast mode"
    else
        print_warning "Consider supporting Increase Contrast"
        echo "         Tip: @Environment(\\.colorSchemeContrast) var contrast"
    fi
}

# Reduce Motion
print_section "4. REDUCE MOTION"

check_reduce_motion() {
    if grep -q '@Environment(.*accessibilityReduceMotion)' "$1"; then
        print_success "Respecting Reduce Motion preference"
    else
        if grep -q 'withAnimation\|\.animation' "$1"; then
            print_error "Animations present but not respecting Reduce Motion"
            echo "         Fix: @Environment(\\.accessibilityReduceMotion) var reduceMotion"
        fi
    fi
}

# Touch Targets
print_section "5. TOUCH TARGETS"

count_interactive_controls_missing_touch_targets() {
    perl -0ne '
        my @lines = split /\n/, $_;
        my $missing = 0;

        sub line_indent {
            my ($line) = @_;
            return length(($line =~ /^(\s*)/)[0] // "");
        }

        sub is_interactive_line {
            my ($line) = @_;
            return $line =~ /\bButton\b\s*(?:\(|\{)/
                || $line =~ /\.onTapGesture\b\s*(?:\(|\{)/;
        }

        sub has_touch_target {
            my ($snippet) = @_;
            my $has_width = $snippet =~ /\.frame\s*\([^\)]*(?:minWidth|width)\s*:\s*(?:4[4-9]|[5-9][0-9]|\d{3,})/s;
            my $has_height = $snippet =~ /\.frame\s*\([^\)]*(?:minHeight|height)\s*:\s*(?:4[4-9]|[5-9][0-9]|\d{3,})/s;
            return $has_width && $has_height;
        }

        my %seen;
        for (my $index = 0; $index < scalar @lines; $index += 1) {
            next unless is_interactive_line($lines[$index]);

            my $start = $index;
            if ($lines[$index] =~ /\.onTapGesture\s*(?:\(|\{)/) {
                while ($start > 0 && $lines[$start] =~ /^\s*\./) {
                    $start -= 1;
                }
            }
            next if $seen{$start};
            $seen{$start} = 1;

            my $indent = line_indent($lines[$start]);
            my $snippet = "";
            for (my $chain_index = $start; $chain_index < scalar @lines && $chain_index < $start + 80; $chain_index += 1) {
                my $line = $lines[$chain_index];
                if ($chain_index > $start
                    && $line =~ /\S/
                    && line_indent($line) <= $indent
                    && $line !~ /^\s*[.)}]/) {
                    last;
                }
                $snippet .= "$line\n";
            }

            if (!has_touch_target($snippet)) {
                $missing += 1;
            }
        }

        print "$missing\n";
    ' "$1"
}

check_touch_targets() {
    if grep -Eq 'Button[[:space:]]*(\(|\{)|\.onTapGesture[[:space:]]*(\(|\{)' "$1"; then
        local undersized_count
        undersized_count="$(count_interactive_controls_missing_touch_targets "$1")"
        if [ "$undersized_count" -eq 0 ]; then
            print_success "Interactive controls specify minimum touch targets"
        else
            print_error "$undersized_count interactive control(s) may have too-small touch targets"
            echo "         Fix: .frame(minWidth: 44, minHeight: 44)"
        fi
    fi
}

run_accessibility_checks() {
    local file="$1"
    check_voiceover "$file"
    check_dynamic_type "$file"
    check_color_contrast "$file"
    check_reduce_motion "$file"
    check_touch_targets "$file"
}

# Run checks
if [ -f "$TARGET" ]; then
    if [[ "$TARGET" == *.swift ]]; then
        run_accessibility_checks "$TARGET"
    else
        print_error "File is not a Swift file: $TARGET"
        exit 1
    fi
elif [ -d "$TARGET" ]; then
    swift_file_count=0
    while IFS= read -r file; do
        swift_file_count=$((swift_file_count + 1))
        print_info "Checking: $file"
        run_accessibility_checks "$file"
        echo ""
    done < <(find "$TARGET" -type f -name "*.swift" 2>/dev/null)

    if [ "$swift_file_count" -eq 0 ]; then
        print_error "No Swift files found in $TARGET"
        exit 1
    fi
fi

# Summary
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                 Accessibility Summary                      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}✓ Passed:   $PASS_COUNT${NC}"
echo -e "${RED}✗ Failed:   $FAIL_COUNT${NC}"
echo -e "${YELLOW}⚠ Warnings: $WARNING_COUNT${NC}"
echo ""

TOTAL=$((PASS_COUNT + FAIL_COUNT))
if [ $TOTAL -gt 0 ]; then
    SCORE=$(( (PASS_COUNT * 100) / TOTAL ))
    echo "Accessibility Score: $SCORE%"
    echo ""
fi

echo ""
print_info "Testing Recommendations:"
echo "  1. Test with VoiceOver enabled (Settings > Accessibility > VoiceOver)"
echo "  2. Test with largest Dynamic Type size"
echo "  3. Test with Increase Contrast enabled"
echo "  4. Test with Reduce Motion enabled"
echo "  5. Test with Reduce Transparency enabled"
echo "  6. Use Accessibility Inspector in Xcode"
echo ""
print_info "Resources:"
echo "  - Accessibility Inspector: Xcode > Open Developer Tool"
echo "  - Apple Accessibility: https://www.apple.com/accessibility/"
echo ""

[ $FAIL_COUNT -gt 0 ] && exit 1 || exit 0
