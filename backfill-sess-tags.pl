#!/usr/bin/env perl
# tx-1e5a5 backfill: add `sess-<sessionId>` tag to each nug markdown file.
# Session derived from the frontmatter `name:` — atoms carry a `(<sess>#idx)`
# suffix; session-summary nugs have name == <sess>. Idempotent: skips if the
# tag is already present. Prints per-file result to STDERR summary counts.
# Usage: find <container>/kg/reference -name '*.md' | perl backfill-sess-tags.pl
use strict; use warnings;
my ($tagged, $already, $noderive) = (0,0,0);
while (my $file = <STDIN>) {
  chomp $file;
  next unless -f $file;
  open my $fh, '<', $file or next;
  local $/; my $content = <$fh>; close $fh;

  # extract name value from frontmatter
  my ($name) = $content =~ /^name:\s*(.*)$/m;
  next unless defined $name;
  $name =~ s/^\s*['"]?//; $name =~ s/['"]?\s*$//;

  # derive session key
  my $sess;
  if ($name =~ /\(([^()]+)#\d+\)\s*$/)        { $sess = $1; }   # atom
  elsif ($name =~ /^([A-Za-z0-9_]+-session-\d+)$/) { $sess = $1; }   # summary
  else { $noderive++; next; }
  my $tag = "sess-$sess";

  if ($content =~ /^\s*-\s+\Q$tag\E\s*$/m) { $already++; next; }

  # insert as first list item after the `tags:` line
  unless ($content =~ s/^(tags:\n)/$1    - $tag\n/m) { $noderive++; next; }
  open my $out, '>', $file or next;
  print $out $content; close $out;
  $tagged++;
}
print STDERR "tagged=$tagged already=$already noderive=$noderive\n";
